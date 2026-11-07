import { DriverHealthSettings } from './DriverHealthSettings.tsx';
import { HyperNeoSessionSettings } from './HyperNeoSessionSettings.tsx';
import { ModelsSettings } from './ModelsSettings.tsx';
import { NeoWorkerPermissionSettings } from './NeoWorkerPermissionSettings.tsx';

export function SessionsHarnessSettings() {
  return (
    <>
      <ModelsSettings />
      <HyperNeoSessionSettings />
      <NeoWorkerPermissionSettings />
      <DriverHealthSettings />
    </>
  );
}
