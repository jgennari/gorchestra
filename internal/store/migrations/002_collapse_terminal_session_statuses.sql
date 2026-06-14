UPDATE sessions
SET status = 'idle',
    completed_at = NULL
WHERE status IN ('completed', 'cancelled');
