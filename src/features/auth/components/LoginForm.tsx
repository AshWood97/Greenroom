import React, { useEffect, useState } from 'react';
import {
  Mail,
  User,
  Lock as LockIcon,
  Eye,
  EyeOff,
  AlertCircle,
  ArrowRight,
  ShieldCheck,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import styles from './LoginForm.module.css';
import greenroomIcon from '../../../assets/greenroom-icon.png';
import { authService, MfaRequired } from '../services/authService';
import { AuthSession } from '../types/auth';
import { VALID_MEMBERS } from '../constants/members';
import { maskDisplayName } from '../utils/mask';

interface LoginFormProps {
  onLoginSuccess: (session: AuthSession) => void;
}

export const LoginForm: React.FC<LoginFormProps> = ({ onLoginSuccess }) => {
  const [email, setEmail] = useState('');
  const [feishuName, setFeishuName] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [showMembersList, setShowMembersList] = useState(false);
  const [rosterSize, setRosterSize] = useState(VALID_MEMBERS.length);
  const [externalActive, setExternalActive] = useState(true);
  const [localMemberName, setLocalMemberName] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    authService.options().then((options) => {
      if (options.rosterSize > 0) setRosterSize(options.rosterSize);
      setExternalActive(options.externalAuthActive);
      setLocalMemberName(options.localMemberName);
      if (options.localMemberName) setEmail(options.localMemberName);
      setAuthReady(true);
    }).catch(() => setErrorMessage('登录配置暂时不可用，请稍后刷新'));
  }, []);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!authReady) return;
    if (externalActive && !feishuName.trim()) {
      setErrorMessage('请输入受邀名单上的完整飞书姓名');
      return;
    }
    setErrorMessage(null);
    setIsLoading(true);
    try {
      const session = localMemberName
        ? await authService.developmentLogin()
        : challengeId
          ? await authService.verifyMfa(challengeId, code, feishuName.trim())
          : await authService.login(email, password, externalActive ? 'external' : 'internal', feishuName.trim());
      onLoginSuccess(session);
    } catch (err) {
      if (err instanceof MfaRequired) {
        setChallengeId(err.challengeId);
        return;
      }
      setErrorMessage(err instanceof Error ? err.message : '登录失败，请核对信息');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className={styles.loginWrapper}>
      <div className={styles.ambientGlow} />

      <div className={styles.loginCard}>
        <div className={styles.cardHeader}>
          <div className={styles.brandBadge}>
            <img className={styles.brandIcon} src={greenroomIcon} width={22} height={22} alt="" />
            <span className={styles.brandText}>Greenroom</span>
          </div>
          <h1 className={styles.title}>管理面板登录</h1>
          <p className={styles.subtitle}>
            {challengeId
              ? '输入统一认证发来的验证码'
              : localMemberName
                ? '本机开发账号已准备好，点击进入'
                : externalActive
                  ? '使用已加入团队的统一认证邮箱与飞书姓名登录，注册未开放'
                  : '输入成员姓名和访问口令'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className={styles.form}>
          {errorMessage && (
            <div className={styles.errorBanner} role="alert">
              <AlertCircle size={18} />
              <span>{errorMessage}</span>
            </div>
          )}

          <div className={styles.formGroup}>
            <div className={styles.labelRow}>
              <label htmlFor="email-input" className={styles.label}>
                {localMemberName ? '本机开发账号' : externalActive ? '登录邮箱' : '成员姓名'}
              </label>
            </div>
            <div className={styles.inputContainer}>
              <Mail size={18} className={styles.inputIcon} />
              <input
                id="email-input"
                type={externalActive ? 'email' : 'text'}
                autoComplete="username"
                className={styles.input}
                placeholder={externalActive ? 'name@company.com' : '请输入成员姓名'}
                value={email}
                readOnly={Boolean(localMemberName)}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (errorMessage) setErrorMessage(null);
                }}
                disabled={isLoading || Boolean(challengeId)}
                autoFocus
              />
            </div>
          </div>

          {externalActive && !challengeId && (
            <div className={styles.formGroup}>
              <div className={styles.labelRow}>
                <label htmlFor="feishu-name-input" className={styles.label}>
                  飞书名称
                </label>
              </div>
              <div className={styles.inputContainer}>
                <User size={18} className={styles.inputIcon} />
                <input
                  id="feishu-name-input"
                  type="text"
                  autoComplete="name"
                  className={styles.input}
                  placeholder={`受邀 ${rosterSize} 人名单完整姓名`}
                  value={feishuName}
                  onChange={(e) => {
                    setFeishuName(e.target.value);
                    if (errorMessage) setErrorMessage(null);
                  }}
                  disabled={isLoading}
                />
              </div>
            </div>
          )}

          {challengeId ? (
            <div className={styles.formGroup}>
              <div className={styles.labelRow}>
                <label htmlFor="code-input" className={styles.label}>
                  验证码
                </label>
              </div>
              <div className={styles.inputContainer}>
                <LockIcon size={18} className={styles.inputIcon} />
                <input
                  id="code-input"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  className={styles.input}
                  placeholder="6 位验证码"
                  value={code}
                  onChange={(e) => {
                    setCode(e.target.value);
                    if (errorMessage) setErrorMessage(null);
                  }}
                  disabled={isLoading || !authReady}
                  autoFocus
                />
              </div>
            </div>
          ) : !localMemberName && (
            <div className={styles.formGroup}>
              <div className={styles.labelRow}>
                <label htmlFor="password-input" className={styles.label}>
                  统一认证密码
                </label>
              </div>
              <div className={styles.inputContainer}>
                <LockIcon size={18} className={styles.inputIcon} />
                <input
                  id="password-input"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  className={`${styles.input} ${styles.inputWithToggle}`}
                  placeholder={externalActive ? '请输入统一认证密码' : '访问口令'}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    if (errorMessage) setErrorMessage(null);
                  }}
                  disabled={isLoading || !authReady}
                />
                <button
                  type="button"
                  className={styles.togglePasswordBtn}
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? '隐藏密码' : '显示密码'}
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
          )}

          <button type="submit" className={styles.submitBtn} disabled={isLoading || !authReady}>
            <span>{isLoading ? '正在验证身份...' : challengeId ? '验证并进入' : '进入管理面板'}</span>
            <ArrowRight size={16} />
          </button>

          {challengeId && (
            <button
              type="button"
              className={styles.memberHintsTrigger}
              onClick={() => {
                setChallengeId(null);
                setCode('');
                setErrorMessage(null);
              }}
            >
              返回重新输入密码
            </button>
          )}

          <div>
            <button
              type="button"
              className={styles.memberHintsTrigger}
              onClick={() => setShowMembersList(!showMembersList)}
            >
              <span>查看受邀成员名单 ({rosterSize} 人)</span>
              {showMembersList ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>

            {showMembersList && (
              <div className={styles.membersDrawer}>
                <div className={styles.drawerTitle}>名单仅供辨认，登录使用各自的邮箱</div>
                <div className={styles.memberChipsGrid}>
                  {VALID_MEMBERS.map((member) => (
                    <span key={member.id} className={styles.memberChip}>
                      {maskDisplayName(member.displayName)}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </form>

        <div className={styles.cardFooter}>
          <ShieldCheck size={14} />
          <span>Greenroom {__APP_VERSION__} · 内部控制台系统</span>
        </div>
      </div>
    </div>
  );
};
