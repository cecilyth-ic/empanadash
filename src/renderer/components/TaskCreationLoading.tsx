import React, { useEffect, useState } from 'react';
import { Spinner } from './ui/spinner';
import { cn } from '@/lib/utils';

interface TaskCreationLoadingProps {
  className?: string;
  isRemote?: boolean;
}

const REMOTE_STEPS = [
  'Creating remote worktree...',
  'Setting up sparse checkout...',
  'Checking out files...',
];

const TaskCreationLoading: React.FC<TaskCreationLoadingProps> = ({ className, isRemote }) => {
  const [stepIndex, setStepIndex] = useState(0);

  useEffect(() => {
    if (!isRemote) return;
    const interval = setInterval(() => {
      setStepIndex((prev) => Math.min(prev + 1, REMOTE_STEPS.length - 1));
    }, 5000);
    return () => clearInterval(interval);
  }, [isRemote]);

  const message = isRemote ? REMOTE_STEPS[stepIndex] : 'Creating task...';

  return (
    <div
      className={cn('flex h-full min-h-0 flex-col items-center justify-center gap-3', className)}
    >
      <Spinner size="lg" />
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  );
};

export default TaskCreationLoading;
