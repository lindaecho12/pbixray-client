export function normalizeUrl(baseUrl: string, mountPath: string): string {
  const trimmedBase = baseUrl.replace(/\/$/, '');
  if (!mountPath.startsWith('/')) mountPath = '/' + mountPath;
  // Remove trailing slash from mount path unless root
  mountPath = mountPath === '/' ? '/' : mountPath.replace(/\/$/, '');
  try {
    const parsed = new URL(trimmedBase);
    const currentPath = parsed.pathname.replace(/\/$/, '') || '';
    if (currentPath === mountPath) {
      return trimmedBase; // already matches
    }
    // If base already ends with mount path segment, don't duplicate
    if (currentPath.endsWith(mountPath)) {
      return trimmedBase;
    }
    parsed.pathname = (currentPath + mountPath).replace(/\/+/g, '/');
    return parsed.toString().replace(/\/$/, '');
  } catch {
    // Fallback simple concat if URL constructor fails
    return trimmedBase + mountPath;
  }
}
