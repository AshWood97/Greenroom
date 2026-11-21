import React, { useState, useEffect, useRef } from 'react';
import { LoginForm } from '../features/auth/components/LoginForm';
import { AdminDashboard } from '../features/admin/components/AdminDashboard';
import { HarnessModal } from '../features/agent-harness/components/HarnessModal';
import { authService } from '../features/auth/services/authService';
import { AuthSession, MemberUser } from '../features/auth/types/auth';
import { VALID_MEMBERS } from '../features/auth/constants/members';

export const App: React.FC = () => {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [members, setMembers] = useState<MemberUser[]>(VALID_MEMBERS);
  const [isInitializing, setIsInitializing] = useState(true);
  const [logoutError, setLogoutError] = useState('');
  const logoutPending = useRef(false);
  const sessionGeneration = useRef(0);

  useEffect(() => {
    let cancelled = false;
    authService.restore().then((restored) => {
      if (cancelled) return;
      if (restored) {
        setSession(restored.session);
        if (restored.members.length > 0) setMembers(restored.members);
      }
      setIsInitializing(false);
    }).catch(() => {
      if (!cancelled) setIsInitializing(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLoginSuccess = (next: AuthSession) => {
    sessionGeneration.current += 1;
    setLogoutError('');
    setSession(next);
  };

  const handleLogout = () => {
    if (logoutPending.current) return;
    logoutPending.current = true;
    const generation = sessionGeneration.current;
    setLogoutError('');
    authService.logout().then(() => {
      if (sessionGeneration.current === generation) setSession(null);
    }).catch((error) => {
      if (sessionGeneration.current === generation) {
        setLogoutError('退出尚未确认，请重试。' + (error instanceof Error ? error.message : '网络异常，请重试'));
      }
    }).finally(() => { logoutPending.current = false; });
  };

  if (isInitializing) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#090d10',
          color: '#10b981',
          fontSize: '14px',
          fontWeight: 600,
          letterSpacing: '0.05em',
        }}
      >
        <span>载入 Greenroom 控制台...</span>
      </div>
    );
  }

  // 与服务端保持一致：本地用户可访问控制台。
  const isAdmin = session?.user.id === 'user_greenroom_local';

  return (
    <>
      {logoutError && <div role="alert" style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 10000, padding: 12, color: '#fff', background: '#991b1b' }}>{logoutError}</div>}
      {session ? (
        isAdmin ? (
          <AdminDashboard session={session} members={members} onLogout={handleLogout} />
        ) : (
          <HarnessModal
            user={session.user}
            isOpen={true}
            isStandalone={true}
            onLogout={handleLogout}
          />
        )
      ) : (
        <LoginForm onLoginSuccess={handleLoginSuccess} />
      )}
    </>
  );
};

export default App;
