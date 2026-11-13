import React from 'react';
import { useOrbitStore } from '../../store/useOrbitStore';
import { ExplorerView } from './ExplorerView';

export const DualPaneView: React.FC = () => {
  const {
    isDualPane,
    getRemoteFiles,
    currentPath,
    setCurrentPath,
    selectedRemotePath,
    selectRemoteFile,
    localFiles,
    localPath,
    setLocalPath,
    selectedLocalPath,
    selectLocalFile,
  } = useOrbitStore();

  const remoteFiles = getRemoteFiles();

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

