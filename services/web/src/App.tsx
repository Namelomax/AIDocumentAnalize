import { useCallback, useState } from 'react';
import Sidebar from './components/Sidebar';
import LoginScreen from './screens/LoginScreen';
import DashboardScreen from './screens/DashboardScreen';
import UploadScreen from './screens/UploadScreen';
import ProcessingScreen from './screens/ProcessingScreen';
import ProtocolScreen from './screens/ProtocolScreen';
import VerificationScreen from './screens/VerificationScreen';
import FinalizationScreen from './screens/FinalizationScreen';
import HypothesesScreen from './screens/HypothesesScreen';

export type ScreenId =
  | 'dashboard'
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
}

export default function App() {
  const [authenticated, setAuthenticated] = useState(false);
  const [nav, setNav] = useState<NavState>({ screen: 'dashboard' });

  const onNavigate = useCallback((next: NavState) => {
    setNav(next);
    requestAnimationFrame(() => window.scrollTo(0, 0));
  }, []);

  if (!authenticated) {
    return <LoginScreen onLogin={() => setAuthenticated(true)} />;
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#F5F7FA]">
      <Sidebar
        activeSection={nav.screen}
        onNavigate={(s) => onNavigate({ screen: s })}
      />

      <main className="flex-1 min-w-0 h-screen overflow-hidden flex flex-col">
        {nav.screen === 'dashboard' && (
          <DashboardScreen
            onOpenObject={(objectId) => onNavigate({ screen: 'upload', objectId })}
          />
        )}

        {nav.screen === 'upload' && (
          <UploadScreen
            objectId={nav.objectId ?? 'obj-altuf'}
            onBack={() => onNavigate({ screen: 'dashboard' })}
            onRunCheck={(objectId) => onNavigate({ screen: 'processing', objectId })}
          />
        )}

        {nav.screen === 'processing' && (
          <ProcessingScreen
            objectId={nav.objectId}
            onBack={() => onNavigate({ screen: 'upload', objectId: nav.objectId })}
            onComplete={() =>
              onNavigate({
                screen: 'protocol',
                objectId: nav.objectId,
                protocolId: 'p-2025-0147'
              })
            }
          />
        )}

        {nav.screen === 'protocol' && (
          <ProtocolScreen
            protocolId={nav.protocolId ?? 'p-2025-0147'}
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
            protocolId={nav.protocolId ?? 'p-2025-0147'}
            onBack={() => onNavigate({ screen: 'protocol', protocolId: nav.protocolId })}
            onFinish={(protocolId) =>
              onNavigate({ screen: 'finalization', protocolId, objectId: nav.objectId })
            }
          />
        )}

        {nav.screen === 'finalization' && (
          <FinalizationScreen
            protocolId={nav.protocolId ?? 'p-2025-0147'}
            onBack={() => onNavigate({ screen: 'verification', protocolId: nav.protocolId })}
          />
        )}

        {nav.screen === 'hypotheses' && (
          <HypothesesScreen
            onBack={() => onNavigate({ screen: 'protocol', protocolId: nav.protocolId })}
            onPromote={() =>
              onNavigate({ screen: 'verification', protocolId: nav.protocolId, objectId: nav.objectId })
            }
          />
        )}
      </main>
    </div>
  );
}