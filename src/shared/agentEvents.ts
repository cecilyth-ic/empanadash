export type AgentEventType = 'notification' | 'stop' | 'error' | 'teammate_spawn';

export type NotificationType =
  | 'permission_prompt'
  | 'idle_prompt'
  | 'auth_success'
  | 'elicitation_dialog';

export interface AgentEvent {
  type: AgentEventType;
  ptyId: string;
  taskId: string;
  providerId: string;
  timestamp: number;
  payload: {
    notificationType?: NotificationType;
    title?: string;
    message?: string;
    lastAssistantMessage?: string;
    // teammate_spawn fields
    agentName?: string;
    tmuxSocket?: string;
    paneId?: string;
  };
}

export type SoundEvent = 'needs_attention' | 'task_complete';
