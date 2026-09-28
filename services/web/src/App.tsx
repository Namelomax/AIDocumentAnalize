import { useCallback, useEffect, useState } from 'react';
import Sidebar from './components/Sidebar';
import LoginScreen from './screens/LoginScreen';
import DashboardScreen from './screens/DashboardScreen';
import ObjectScreen from './screens/ObjectScreen';
import UploadScreen from './screens/UploadScreen';
import ProcessingScreen from './screens/ProcessingScreen';
import ProtocolScreen from './screens/ProtocolScreen';
import VerificationScreen from './screens/VerificationScreen';
import FinalizationScreen from './screens/FinalizationScreen';
import HypothesesScreen from './screens/HypothesesScreen';
import { clearSession, getSession, onUnauthorized, type Session } from './api/client';
import type { AppNotification } from './types';

export type ScreenId =
  | 'dashboard'
  | 'object'
  | 'upload'
  | 'processing'
  | 'protocol'
  | 'verification'
  | 'finalization'
  | 'hypotheses';

export interface NavState {
  screen: ScreenId;
  objectId?: string;
  protocolId?: string;
  processId?: string;
}

export default function App() {
  // sessionStorage is the source of truth (client.ts) — this only mirrors it
  // into React state so the screen tree can react to login/logout.
  const [session, setSession] = useState<Session | null>(() => getSession());
  const [nav, setNav] = useState<NavState>({ screen: 'dashboard' });

  const onNavigate = useCallback((next: NavState) => {
    setNav(next);
    requestAnimationFrame(() => window.scrollTo(0, 0));
  }, []);

  // Global Constraint (Plan 7): a 401 from any request, anywhere in the app,
  // drops the session and falls back to the login screen.
  useEffect(() => onUnauthorized(() => setSession(null)), []);

  if (!session) {
    return <LoginScreen onLogin={setSession} />;
  }

  const handleLogout = () => {
    clearSession();
    setSession(null);
  };

  // Both notification kinds the worker/API ever create carry an object_id
  // (PROCESS_READY, FILE_PROCESSING_FAILED, PROCESS_FAILED all originate
  // from a process, which always has one) - the object screen is the
  // universal landing page, since it is also where "Протоколы" lives.
  const handleOpenNotification = (notification: AppNotification) => {
    if (notification.objectId) {
      onNavigate({ screen: 'object', objectId: notification.objectId });
    }
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#F5F7FA]">
      <Sidebar
        activeSection={nav.screen}
        onNavigate={(screen) => onNavigate({ screen })}
        user={session.user}
        onLogout={handleLogout}
        onOpenNotification={handleOpenNotification}
      />

      <main className="flex-1 min-w-0 h-screen overflow-hidden flex flex-col">
        {nav.screen === 'dashboard' && (
          <DashboardScreen
            onOpenObject={(objectId) => onNavigate({ screen: 'object', objectId })}
          />
        )}

        {nav.screen === 'object' && nav.objectId && (
          <ObjectScreen
            objectId={nav.objectId}
            onBack={() => onNavigate({ screen: 'dashboard' })}
            onOpenUpload={(objectId) => onNavigate({ screen: 'upload', objectId })}
            onOpenProtocol={(objectId, protocolId) =>
              onNavigate({ screen: 'protocol', objectId, protocolId })
            }
          />
        )}

        {nav.screen === 'upload' && nav.objectId && (
          <UploadScreen
            objectId={nav.objectId}
            onBack={() => onNavigate({ screen: 'object', objectId: nav.objectId })}
            onRunCheck={(objectId, processId) =>
              onNavigate({ screen: 'processing', objectId, processId })
            }
          />
        )}

        {nav.screen === 'processing' && (
          <ProcessingScreen
            objectId={nav.objectId}
            processId={nav.processId}
            onBack={() => onNavigate({ screen: 'upload', objectId: nav.objectId })}
            onComplete={(protocolId) =>
              onNavigate({
                screen: 'protocol',
                objectId: nav.objectId,
                protocolId,
                processId: nav.processId
              })
            }
          />
        )}

        {nav.screen === 'protocol' && (
          <ProtocolScreen
            protocolId={nav.protocolId ?? ''}
            onBack={() => onNavigate({ screen: 'upload', objectId: nav.objectId })}
            onOpenVerification={(protocolId) =>
              onNavigate({ screen: 'verification', protocolId, objectId: nav.objectId })
            }
            onOpenHypotheses={(protocolId) =>
              onNavigate({ screen: 'hypotheses', protocolId, objectId: nav.objectId })
            }
          />
        )}

        {nav.screen === 'verification' && (
          <VerificationScreen
            protocolId={nav.protocolId ?? ''}
            onBack={() => onNavigate({ screen: 'protocol', protocolId: nav.protocolId })}
            onFinish={(protocolId) =>
              onNavigate({ screen: 'finalization', protocolId, objectId: nav.objectId })
            }
          />
        )}

        {nav.screen === 'finalization' && (
          <FinalizationScreen
            protocolId={nav.protocolId ?? ''}
            onBack={() => onNavigate({ screen: 'verification', protocolId: nav.protocolId })}
          />
        )}

        {nav.screen === 'hypotheses' && (
          <HypothesesScreen
            protocolId={nav.protocolId}
            onBack={() => (
              nav.protocolId
                ? onNavigate({ screen: 'protocol', protocolId: nav.protocolId, objectId: nav.objectId })
                : onNavigate({ screen: 'dashboard' })
            )}
          />
        )}
      </main>
    </div>
  );
}
