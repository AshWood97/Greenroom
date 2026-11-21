import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import styles from './ReleaseBadge.module.css';

const POLL_INTERVAL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;
const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)$/;
const JSON_CONTENT_TYPE = /^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i;

const parseVersion = (value: unknown): number[] | null => {
  if (typeof value !== 'string') return null;
  const match = VERSION_PATTERN.exec(value.trim());
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
};

const isNewer = (candidate: number[], current: number[]) => {
  for (let index = 0; index < candidate.length; index += 1) {
    if (candidate[index] !== current[index]) return candidate[index] > current[index];
  }
  return false;
};

export const ReleaseBadge: React.FC = () => {
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const base = parseVersion(__APP_VERSION__);
    if (!base) return;

    let disposed = false;
    let hidden = document.visibilityState === 'hidden';
    let timer: number | null = null;
    let controller: AbortController | null = null;
    let inFlight = false;
    let generation = 0;
    let latest = base;

    const clearTimer = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };

    const abortInFlight = () => {
      generation += 1;
      controller?.abort();
      controller = null;
      inFlight = false;
    };

    const schedule = () => {
      clearTimer();
      if (disposed || hidden) return;
      timer = window.setTimeout(() => {
        timer = null;
        void check();
      }, POLL_INTERVAL_MS);
    };

    async function check() {
      if (disposed || hidden || inFlight) return;
      clearTimer();
      inFlight = true;
      const requestId = ++generation;
      const request = new AbortController();
      controller = request;
      const timeout = window.setTimeout(() => request.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(`/api/health?release=${Date.now()}`, {
          method: 'GET',
          cache: 'no-store',
          credentials: 'same-origin',
          redirect: 'error',
          headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
          signal: request.signal,
        });
        if (!response.ok) return;
        if (!JSON_CONTENT_TYPE.test(response.headers.get('content-type') || '')) return;
        const health = await response.json();
        if (disposed || hidden || request.signal.aborted || requestId !== generation || health?.ok !== true) return;
        const candidate = parseVersion(health.product_version);
        if (candidate && isNewer(candidate, latest)) {
          latest = candidate;
          setUpdateVersion(health.product_version.trim());
        }
      } catch {
        // Offline, aborted, unauthenticated or invalid responses leave the badge unchanged.
      } finally {
        window.clearTimeout(timeout);
        if (requestId === generation) {
          inFlight = false;
          controller = null;
          schedule();
        }
      }
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        hidden = true;
        abortInFlight();
        clearTimer();
      } else {
        hidden = false;
        abortInFlight();
        void check();
      }
    };
    const onPageHide = () => {
      hidden = true;
      abortInFlight();
      clearTimer();
    };
    const onPageShow = () => {
      hidden = false;
      abortInFlight();
      void check();
    };
    const onOnline = () => {
      abortInFlight();
      void check();
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('online', onOnline);
    void check();

    return () => {
      disposed = true;
      abortInFlight();
      clearTimer();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('online', onOnline);
    };
  }, []);

  useEffect(() => {
    if (!confirming) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    cancelButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setConfirming(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [confirming]);

  return (
    <>
      <div className={`${styles.badge} ${updateVersion ? styles.hasUpdate : ''}`}>
        {updateVersion ? (
          <>
            <span className={styles.notice} role="status" aria-live="polite">发现新版本 {updateVersion}</span>
            <button
              ref={refreshButton}
              type="button"
              className={styles.refresh}
              onClick={() => setConfirming(true)}
            >
              刷新页面
            </button>
          </>
        ) : (
          <span aria-label="产品版本" title="当前界面版本">{__APP_VERSION__}</span>
        )}
      </div>

      {confirming && createPortal(
        <div
          className={styles.backdrop}
          onClick={(event) => { if (event.target === event.currentTarget) setConfirming(false); }}
        >
          <section
            className={styles.dialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="release-refresh-title"
            aria-describedby="release-refresh-desc"
          >
            <h2 id="release-refresh-title">刷新到新版本</h2>
            <p id="release-refresh-desc">
              刷新会重新加载页面，未保存的修改、未发送的草稿可能丢失，请先保存需要保留的内容。
              已提交的任务与审批记录仍由服务端保存。确定现在刷新吗？
            </p>
            <div className={styles.actions}>
              <button
                ref={cancelButton}
                type="button"
                className={styles.cancel}
                onClick={() => setConfirming(false)}
              >
                继续当前工作
              </button>
              <button
                type="button"
                className={styles.confirm}
                onClick={() => window.location.reload()}
              >
                已保存，刷新
              </button>
            </div>
          </section>
        </div>, document.body,
      )}
    </>
  );
};
