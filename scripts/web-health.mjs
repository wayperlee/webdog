try {
  const response = await fetch(`http://127.0.0.1:${process.env.PORT || 3000}/api/health`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok || !(await response.json()).ok) process.exitCode = 1;
} catch { process.exitCode = 1; }
