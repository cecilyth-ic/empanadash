import { useState, useEffect, useCallback, useRef } from 'react';
import type { ConnectionState } from '../components/ssh';
import type { Project } from '../types/app';

export interface UseRemoteProjectResult {
  isRemote: boolean;
  connectionState: ConnectionState;
  connectionId: string | null;
  host: string | null;
  error: Error | null;
  isLoading: boolean;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  reconnect: () => Promise<void>;
}

// Connection state cache to persist across component unmounts.
// Keyed by projectId for UI components, and by connectionId for the poller.
const connectionStateCache = new Map<string, ConnectionState>();

// Maps connectionId → projectId so the batch poller can update the project-keyed cache.
const connIdToProjectId = new Map<string, string>();

/**
 * Lightweight cache reader for sidebar indicators — no polling, no side effects.
 * Returns the last known state or 'disconnected' if unknown.
 */
export function getConnectionStateFromCache(projectId: string): ConnectionState {
  return connectionStateCache.get(projectId) || 'disconnected';
}

// ---------------------------------------------------------------------------
// Centralized batch poller — ONE interval fetches ALL connection states.
// ---------------------------------------------------------------------------
let batchPollerInterval: ReturnType<typeof setInterval> | null = null;
let batchPollerSubscribers = 0;
const batchPollerListeners = new Set<() => void>();

async function batchPollStates() {
  try {
    const states = await window.electronAPI.sshGetAllStates();
    if (!Array.isArray(states)) return;
    for (const { connectionId, state } of states) {
      const projectId = connIdToProjectId.get(connectionId);
      if (projectId) {
        connectionStateCache.set(projectId, state as ConnectionState);
      }
    }
    // Notify subscribers so they can re-render
    for (const listener of batchPollerListeners) {
      listener();
    }
  } catch {
    // Silently ignore — the main process may not support the new IPC yet
  }
}

function startBatchPoller() {
  batchPollerSubscribers++;
  if (batchPollerSubscribers === 1 && !batchPollerInterval) {
    batchPollStates(); // Immediate first poll
    batchPollerInterval = setInterval(batchPollStates, 10_000);
  }
}

function stopBatchPoller() {
  batchPollerSubscribers = Math.max(0, batchPollerSubscribers - 1);
  if (batchPollerSubscribers === 0 && batchPollerInterval) {
    clearInterval(batchPollerInterval);
    batchPollerInterval = null;
  }
}

/**
 * Hook for sidebar items to subscribe to cached connection state updates.
 * Starts/stops the batch poller based on how many subscribers exist.
 * No per-component IPC — all state comes from the shared batch poll.
 */
export function useConnectionStateFromCache(
  projectId: string | null,
  connectionId: string | null
): ConnectionState {
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    if (!projectId || !connectionId) return;
    connIdToProjectId.set(connectionId, projectId);
    const listener = () => forceUpdate((n) => n + 1);
    batchPollerListeners.add(listener);
    startBatchPoller();
    return () => {
      batchPollerListeners.delete(listener);
      stopBatchPoller();
    };
  }, [projectId, connectionId]);

  if (!projectId) return 'disconnected';
  return connectionStateCache.get(projectId) || 'disconnected';
}

const connectionAttempts = new Map<string, number>();
const MAX_RETRY_ATTEMPTS = 3;

/**
 * Module-level set of connection IDs that currently have an in-flight
 * connect() call. Prevents multiple hooks (or re-renders) from firing
 * parallel TCP connections for the same remote host.
 */
const connectingIds = new Set<string>();

export function useRemoteProject(project: Project | null): UseRemoteProjectResult {
  const [connectionState, setConnectionState] = useState<ConnectionState>(() => {
    if (!project) return 'disconnected';
    // Check if this is a remote project
    const isRemote = (project as any).isRemote || (project as any).sshConnectionId;
    if (!isRemote) return 'disconnected';
    return connectionStateCache.get(project.id) || 'disconnected';
  });
  const [error, setError] = useState<Error | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [host, setHost] = useState<string | null>(null);
  const healthCheckIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const isMountedRef = useRef(true);

  // Determine if this is a remote project
  const isRemote = Boolean(
    project && ((project as any).isRemote || (project as any).sshConnectionId)
  );
  const connectionId =
    project && (project as any).sshConnectionId ? (project as any).sshConnectionId : null;

  // Register the connectionId→projectId mapping for the batch poller
  useEffect(() => {
    if (connectionId && project) {
      connIdToProjectId.set(connectionId, project.id);
    }
  }, [connectionId, project]);

  // Update connection state and cache
  const updateConnectionState = useCallback(
    (state: ConnectionState) => {
      if (project) {
        connectionStateCache.set(project.id, state);
      }
      setConnectionState(state);
    },
    [project]
  );

  // Connect to the remote project
  const connect = useCallback(async () => {
    if (!connectionId) return;

    // Deduplicate: skip if this connectionId already has an in-flight connect
    if (connectingIds.has(connectionId)) return;

    connectingIds.add(connectionId);
    setIsLoading(true);
    setError(null);
    updateConnectionState('connecting');

    try {
      // The API returns the connectionId string directly
      const result = await window.electronAPI.sshConnect(connectionId);

      if (!isMountedRef.current) return;

      // sshConnect returns the connectionId on success, throws on error
      if (result) {
        updateConnectionState('connected');
        connectionAttempts.set(connectionId, 0);
      } else {
        throw new Error('Connection failed');
      }
    } catch (err) {
      if (!isMountedRef.current) return;

      const error = err instanceof Error ? err : new Error('Connection failed');
      setError(error);
      updateConnectionState('error');
      console.error('Failed to connect to remote project:', error);
    } finally {
      connectingIds.delete(connectionId);
      if (isMountedRef.current) {
        setIsLoading(false);
      }
    }
  }, [connectionId, updateConnectionState]);

  // Disconnect from the remote project
  const disconnect = useCallback(async () => {
    if (!connectionId) return;

    setIsLoading(true);
    try {
      await window.electronAPI.sshDisconnect(connectionId);
      if (isMountedRef.current) {
        updateConnectionState('disconnected');
        setError(null);
      }
    } catch (err) {
      if (isMountedRef.current) {
        console.error('Failed to disconnect:', err);
      }
    } finally {
      if (isMountedRef.current) {
        setIsLoading(false);
      }
    }
  }, [connectionId, updateConnectionState]);

  // Reconnect with retry logic
  const reconnect = useCallback(async () => {
    if (!connectionId) return;

    const attempts = connectionAttempts.get(connectionId) || 0;
    if (attempts >= MAX_RETRY_ATTEMPTS) {
      setError(
        new Error(`Max retry attempts (${MAX_RETRY_ATTEMPTS}) reached. Please try again later.`)
      );
      return;
    }

    connectionAttempts.set(connectionId, attempts + 1);
    updateConnectionState('reconnecting');

    // Brief delay before reconnecting
    await new Promise((resolve) => setTimeout(resolve, 1000));

    await connect();
  }, [connectionId, connect, updateConnectionState]);

  // Fetch connection details (host)
  useEffect(() => {
    if (!isRemote || !connectionId) {
      setHost(null);
      return;
    }

    const fetchConnectionDetails = async () => {
      try {
        // The API returns an array directly
        const result = (await window.electronAPI.sshGetConnections()) as Array<{
          id: string;
          host: string;
        }>;
        if (Array.isArray(result)) {
          const conn = result.find((c) => c.id === connectionId);
          if (conn) {
            setHost(conn.host);
          }
        }
      } catch (err) {
        console.warn('Failed to fetch connection details:', err);
      }
    };

    fetchConnectionDetails();
  }, [isRemote, connectionId]);

  // Auto-connect on mount if this is a remote project
  useEffect(() => {
    isMountedRef.current = true;

    if (isRemote && connectionId && connectionState === 'disconnected') {
      // Small delay to allow UI to settle
      const timeout = setTimeout(() => {
        connect();
      }, 500);

      return () => {
        clearTimeout(timeout);
        isMountedRef.current = false;
      };
    }

    return () => {
      isMountedRef.current = false;
    };
  }, [isRemote, connectionId, connect, connectionState]);

  // Health check - poll connection state from the main process monitor.
  // Reconnection is handled exclusively by the main-process
  // SshConnectionMonitor (via ssh2 keepalive + exponential backoff).
  // This effect only syncs the UI state.
  //
  // IMPORTANT: connectionState is intentionally NOT in the dependency array.
  // Including it causes the interval to restart on every state change, which
  // during connection transitions can create rapid-fire IPC calls that
  // saturate the main process and freeze the UI.
  useEffect(() => {
    if (!isRemote || !connectionId) return;

    const checkHealth = async () => {
      try {
        // The API returns the state string directly
        const state = (await window.electronAPI.sshGetState(connectionId)) as ConnectionState;
        if (isMountedRef.current) {
          updateConnectionState(state);
        }
      } catch (err) {
        // Silently ignore health check errors
      }
    };

    // Single fixed interval — no need to vary by state since the main
    // process SshConnectionMonitor handles reconnection.
    checkHealth();
    healthCheckIntervalRef.current = setInterval(checkHealth, 10000);

    return () => {
      if (healthCheckIntervalRef.current) {
        clearInterval(healthCheckIntervalRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRemote, connectionId, updateConnectionState]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      // Don't disconnect on unmount - let the service manage connections
      isMountedRef.current = false;
    };
  }, []);

  return {
    isRemote,
    connectionState,
    connectionId,
    host,
    error,
    isLoading,
    connect,
    disconnect,
    reconnect,
  };
}
