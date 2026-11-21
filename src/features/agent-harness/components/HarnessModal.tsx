import React, { useEffect, useRef, useState } from 'react';
import { Loader2, RefreshCw, LayoutDashboard, LogOut } from 'lucide-react';
import styles from './HarnessModal.module.css';
import { MemberUser } from '../../auth/types/auth';
import { PersonalUsage } from '../../usage/components/PersonalUsage';
import { ReleaseBadge } from './ReleaseBadge';

interface HarnessModalProps {
  user: MemberUser;
  isOpen: boolean;
  onClose?: () => void;
  isStandalone?: boolean;
  onLogout?: () => void;
}

export const HarnessModal: React.FC<HarnessModalProps> = ({
  user,
  isOpen,
  onClose,
  isStandalone = false,
  onLogout,
}) => {
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [preparing, setPreparing] = useState('');
  const [queueState, setQueueState] = useState<'queued' | 'starting' | ''>('');
  const [attempt, setAttempt] = useState(0);
  const frameName = `dsh-${user.id}-${attempt}`;
  const frame = useRef<HTMLIFrameElement>(null);
  const runtimeOrigin = useRef('');
  const cancelQueue = useRef<() => void>(() => {});
  const retryAttempt = useRef<number | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    runtimeOrigin.current = '';
    setError('');
    setPreparing('');
    setQueueState('');
    setLoading(true);
    const controller = new AbortController();
    let timeout: number | undefined;
    let pollTimer: number | undefined;
    let preparationTimer: number | undefined;
    let preparationExpired = false;
    let cancelling = false;
    let retryFailed = retryAttempt.current === attempt;
    let launchRequest: Promise<void> | undefined;
    let legacyProbeDone = false;
    let probeController: AbortController | undefined;
    const startFrameTimeout = () => {
      window.clearTimeout(timeout);
      timeout = window.setTimeout(() => {
        if (!cancelled) {
          setLoading(false);
          setError('工作台连接尚未就绪，请重试');
        }
      }, 30000);
    };
    startFrameTimeout();
    const receiveState = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== runtimeOrigin.current ||
          event.data?.type !== 'greenroom:harness-state') return;
      if (event.data.state === 'ready') {
        preparationExpired = true;
        window.clearTimeout(timeout);
        window.clearTimeout(pollTimer);
        window.clearTimeout(preparationTimer);
        setLoading(false);
        setPreparing('');
        setQueueState('');
        setError('');
      } else if (event.data.state === 'error' || event.data.state === 'reconnecting') {
        preparationExpired = true;
        window.clearTimeout(timeout);
        window.clearTimeout(pollTimer);
        window.clearTimeout(preparationTimer);
        setLoading(false);
        setPreparing('');
        setQueueState('');
        setError(event.data.detail || '工作台连接中断，请重试');
      }
    };
    window.addEventListener('message', receiveState);
    // Older wake responses still use the read-only status endpoint.
    const poll = async () => {
      if (cancelled || preparationExpired) return;
      try {
        const response = await fetch('/api/harness/status', {
          credentials: 'same-origin',
          signal: controller.signal,
        });
        const body = await response.json();
        if (cancelled || preparationExpired) return;
        if (body.ready) {
          requestLaunch();
          return;
        }
        if (body.runtime_state === 'failed') {
          preparationExpired = true;
          window.clearTimeout(preparationTimer);
          setPreparing('');
          setLoading(false);
          setError(body.detail || '工作台准备失败，请手动重试');
          return;
        }
        pollTimer = window.setTimeout(() => void poll(), 2000);
      } catch (err) {
        if (!cancelled && !preparationExpired && (err as Error)?.name !== 'AbortError') {
          pollTimer = window.setTimeout(() => void poll(), 2000);
        }
      }
    };
    const launch = async () => {
      try {
        const explicitRetry = retryFailed;
        retryFailed = false;
        const response = await fetch('/api/harness/launch', {
          method: 'POST',
          credentials: 'same-origin',
          signal: controller.signal,
          ...(explicitRetry ? {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ retry_failed: true }),
          } : {}),
        });
        const body = await response.json();
        if (cancelled || preparationExpired || cancelling) return;
        if (explicitRetry && retryAttempt.current === attempt) retryAttempt.current = null;
        if (response.status === 202) {
          window.clearTimeout(timeout);
          setError('');
          setLoading(false);
          if (body.runtime_state === 'queued' ||
              (body.runtime_state === 'starting' && body.outcome_unknown === true)) {
            window.clearTimeout(preparationTimer);
            preparationTimer = undefined;
          }
          if (body.runtime_state === 'queued' || body.runtime_state === 'starting') {
            setQueueState(body.runtime_state);
            setPreparing(body.detail || '工作台正在准备，请稍候…');
            if (!legacyProbeDone && body.legacy_probe &&
                typeof body.legacy_probe.origin === 'string' &&
                typeof body.legacy_probe.proof === 'string') {
              try {
                // The origin is selected by the authenticated launch endpoint;
                // the proof is bound on the server to that member and origin.
                const target = new URL(body.legacy_probe.origin);
                if (target.protocol === 'https:' && target.origin === body.legacy_probe.origin &&
                    target.origin !== window.location.origin && !target.username && !target.password &&
                    target.pathname === '/' && !target.search && !target.hash) {
                  probeController = new AbortController();
                  const abortProbe = () => probeController?.abort();
                  controller.signal.addEventListener('abort', abortProbe, { once: true });
                  const probeTimeout = window.setTimeout(abortProbe, 5000);
                  try {
                    const probe = await fetch(`${target.origin}/_greenroom/legacy-entry`, {
                      method: 'POST', credentials: 'include', redirect: 'error',
                      headers: { 'Content-Type': 'text/plain' },
                      body: body.legacy_probe.proof,
                      signal: probeController.signal,
                    });
                    const result = probe.ok ? await probe.json() : null;
                    if (result?.state === 'adopted' || result?.state === 'absent') {
                      legacyProbeDone = true;
                      if (result.state === 'adopted' && !cancelled && !cancelling) {
                        pollTimer = window.setTimeout(requestLaunch, 0);
                        return;
                      }
                    }
                  } finally {
                    window.clearTimeout(probeTimeout);
                    controller.signal.removeEventListener('abort', abortProbe);
                    probeController = undefined;
                  }
                }
              } catch {
                // A missing cookie or temporary probe failure must never end
                // the regular member queue; retry at the launch interval.
              }
            }
          }
          if (cancelled || preparationExpired || cancelling) return;
          if (body.runtime_state === 'queued') {
            // Time spent waiting for capacity is not time spent starting the
            // workbench. Keep the same request in the queue until cancelled.
            window.clearTimeout(preparationTimer);
            preparationTimer = undefined;
            setQueueState('queued');
            setPreparing(body.detail ? `${body.detail}，正在排队等待工作台…` : '当前使用人数较多，正在排队等待工作台…');
            pollTimer = window.setTimeout(requestLaunch, body.retry_after_ms || 2000);
            return;
          }
          setQueueState(body.runtime_state === 'starting' ? 'starting' : '');
          setPreparing(body.detail || '工作台正在准备，请稍候…');
          if (body.runtime_state === 'starting' && body.outcome_unknown === true) {
            window.clearTimeout(preparationTimer);
            preparationTimer = undefined;
          } else if (preparationTimer === undefined) preparationTimer = window.setTimeout(() => {
            if (cancelled) return;
            preparationExpired = true;
            window.clearTimeout(pollTimer);
            setPreparing('');
            setQueueState('');
            setError(body.detail || '工作台准备超时，请手动重试');
          }, 90000);
          pollTimer = window.setTimeout(
            body.runtime_state === 'starting' ? requestLaunch : () => void poll(),
            body.retry_after_ms || 2000,
          );
          return;
        }
        if (!response.ok) throw new Error(body.detail || '工作台启动失败');
        window.clearTimeout(preparationTimer);
        window.clearTimeout(pollTimer);
        setPreparing('');
        setQueueState('');
        const target = new URL(body.action);
        if (
          target.protocol !== 'https:' ||
          target.origin === window.location.origin ||
          target.pathname !== '/bootstrap'
        ) {
          throw new Error('工作台地址无效');
        }
        startFrameTimeout();
        runtimeOrigin.current = target.origin;
        const form = document.createElement('form');
        form.method = 'POST';
        form.action = target.href;
        form.target = frameName;
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = 'ticket';
        input.value = body.ticket;
        form.appendChild(input);
        document.body.appendChild(form);
        form.submit();
        form.remove();
        preparationExpired = true;
      } catch (err) {
        if (!cancelled && !preparationExpired && !cancelling) {
          window.clearTimeout(timeout);
          window.clearTimeout(pollTimer);
          window.clearTimeout(preparationTimer);
          setPreparing('');
          setQueueState('');
          setError(err instanceof Error ? err.message : '工作台暂不可用');
          setLoading(false);
        }
      }
    };
    const requestLaunch = () => {
      if (cancelled || preparationExpired || cancelling || launchRequest) return;
      launchRequest = launch().finally(() => { launchRequest = undefined; });
    };
    cancelQueue.current = () => {
      if (cancelled || preparationExpired || cancelling) return;
      cancelling = true;
      window.clearTimeout(pollTimer);
      probeController?.abort();
      setQueueState('');
      setPreparing('正在取消排队…');
      void (async () => {
        try {
          // Let an in-flight enqueue finish before cancelling it, so a late
          // POST cannot silently put the member back into the queue.
          if (launchRequest) await launchRequest;
          if (cancelled) return;
          const response = await fetch('/api/harness/launch', {
            method: 'DELETE',
            credentials: 'same-origin',
            signal: controller.signal,
          });
          const body = await response.json();
          if (cancelled) return;
          if (!response.ok) throw new Error(body.detail || '取消排队失败');
          if (body.cancelled === true) {
            preparationExpired = true;
            setPreparing('');
            setError('已取消排队');
          } else {
            // Starting or admitted work is not cancelled by this endpoint.
            cancelling = false;
            setQueueState('starting');
            setPreparing('工作台已开始准备，请稍候…');
            requestLaunch();
          }
        } catch (err) {
          if (!cancelled && (err as Error)?.name !== 'AbortError') {
            preparationExpired = true;
            setPreparing('');
            setError(err instanceof Error ? err.message : '取消排队失败');
          }
        }
      })();
    };
    requestLaunch();
    return () => {
      cancelled = true;
      runtimeOrigin.current = '';
      cancelQueue.current = () => {};
      controller.abort();
      window.clearTimeout(timeout);
      window.clearTimeout(pollTimer);
      window.clearTimeout(preparationTimer);
      window.removeEventListener('message', receiveState);
    };
  }, [isOpen, user.id, frameName, attempt]);

  if (!isOpen) return null;

  return (
    <div
      className={styles.fullscreenWorkbench}
      role="region"
      aria-label={`${user.displayName} 的 DeepSeek Harness 工作台`}
    >
      {/* 右下角 dock，避开 DSH 顶部插件工具栏。 */}
      <div className={styles.floatingNav}>
        {(user.id === 'user_greenroom_local') && !isStandalone && onClose && (
          <button
            type="button"
            className={`${styles.floatingBtn} ${styles.consoleReturn}`}
            onClick={onClose}
            aria-label="返回空间控制台"
            title="返回空间控制台"
          >
            <LayoutDashboard size={14} />
            <span>返回控制台</span>
          </button>
        )}
        <PersonalUsage userId={user.id} className={styles.floatingBtn} />
        {isStandalone && onLogout && (
          <button
            type="button"
            className={`${styles.floatingBtn} ${styles.floatingBtnMuted}`}
            onClick={onLogout}
            aria-label="退出登录"
            title="退出登录"
          >
            <LogOut size={14} />
            <span>退出</span>
          </button>
        )}
        <ReleaseBadge />
      </div>

      {loading && (
        <div className={styles.workbenchStatus}>
          <Loader2 size={18} className={styles.spinning} />
          <span>正在进入您的工作台…</span>
        </div>
      )}

      {preparing && !error && (
        <div className={styles.workbenchStatus} role="status">
          <Loader2 size={18} className={styles.spinning} />
          <span>{preparing}</span>
          {queueState === 'queued' && (
            <button type="button" className={styles.floatingBtn} onClick={() => cancelQueue.current()}>
              取消排队
            </button>
          )}
        </div>
      )}

      {error && (
        <div className={styles.workbenchStatus} role="alert">
          <span>{error}</span>
          <button
            type="button"
            className={styles.floatingBtn}
            onClick={() => {
              retryAttempt.current = attempt + 1;
              setAttempt(attempt + 1);
            }}
          >
            <RefreshCw size={14} />
            <span>重试</span>
          </button>
        </div>
      )}

      <iframe
        key={frameName}
        ref={frame}
        name={frameName}
        title={`${user.displayName} 的 DeepSeek Harness 工作台`}
        className={styles.workbenchFrame}
        sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-popups"
        referrerPolicy="no-referrer"
        allow="clipboard-read; clipboard-write; fullscreen"
      />
    </div>
  );
};
