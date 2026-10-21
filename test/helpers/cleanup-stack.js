// Register one hook so an early cleanup error cannot skip later resources.
// Reverse acquisition order: stop processes before deleting their workspace.
export function cleanupStack(t) {
  const cleanups = [];
  t.after(async () => {
    const errors = [];
    for (let i = cleanups.length - 1; i >= 0; i--) {
      try { await cleanups[i](); }
      catch (error) { errors.push(error); }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, 'Fixture cleanup failed');
  });
  return cleanup => cleanups.push(cleanup);
}
