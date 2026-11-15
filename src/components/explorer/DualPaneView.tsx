import React, { useEffect, useRef } from 'react';
import { useOrbitStore } from '../../store/useOrbitStore';
import { ExplorerView } from './ExplorerView';

export const DualPaneView: React.FC = () => {
  const {
    isDualPane,
    getRemoteFiles,
    getLocalFiles,
    currentPath,
    setCurrentPath,
    selectedRemotePath,
    selectRemoteFile,
    localPath,
    setLocalPath,
    selectedLocalPath,
    selectLocalFile,
    refreshLocal,
  } = useOrbitStore();

  const remoteFiles = getRemoteFiles();
  const localFiles = getLocalFiles();
  const hasAttemptedInitialLoad = useRef(false);

  useEffect(() => {
    if (isDualPane && !localPath && !hasAttemptedInitialLoad.current) {
      hasAttemptedInitialLoad.current = true;
      refreshLocal();
    }
  }, [isDualPane, localPath, refreshLocal]);

  if (!isDualPane) {
    return (
      <ExplorerView
        files={remoteFiles}
        currentPath={currentPath}
        onNavigate={setCurrentPath}
        selectedPath={selectedRemotePath}
        onSelect={selectRemoteFile}
      />
    );
  }

  return (
    <div className="flex-1 flex h-full overflow-hidden divide-x divide-border-subtle">
      {/* Left Pane: Local Storage */}
      <div className="flex-1 flex flex-col h-full min-w-0">
        <ExplorerView
          title="Local (Machine)"
          files={localFiles}
          currentPath={localPath}
          onNavigate={setLocalPath}
          selectedPath={selectedLocalPath}
          onSelect={selectLocalFile}
          isLocal
        />
      </div>

      {/* Right Pane: Remote Storage */}
      <div className="flex-1 flex flex-col h-full min-w-0">
        <ExplorerView
          title="Distant (Cloud / Serveur)"
          files={remoteFiles}
          currentPath={currentPath}
          onNavigate={setCurrentPath}
          selectedPath={selectedRemotePath}
          onSelect={selectRemoteFile}
        />
      </div>
    </div>
  );
};

