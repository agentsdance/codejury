// Bind a PR URL to the checkout that cr is about to read and modify.
//
// A URL is not just a label. Letting it name one repository while every git
// command runs in another can review, commit, and push unrelated code under the
// PR's name. Keep this check independent of a hosting CLI so it also works for
// self-hosted GitHub and GitLab instances.

function normalized(host, pathname) {
  const path = pathname
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "");
  if (!host || !path) return null;
  return { host: host.toLowerCase(), path, display: `${host.toLowerCase()}/${path}` };
}

/** Repository identity carried by a GitHub or GitLab-style PR URL. */
export function repositoryFromPrUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  const parts = url.pathname.split("/").filter(Boolean);
  const marker = parts.findIndex((p) => p === "pull" || p === "merge_requests");
  if (marker < 2 || !/^\d+$/.test(parts[marker + 1] ?? "")) return null;

  const repo = parts.slice(0, marker);
  // Canonical GitLab links use /group/project/-/merge_requests/123.
  if (repo.at(-1) === "-") repo.pop();
  if (repo.length < 2) return null;
  return normalized(url.hostname, repo.join("/"));
}

/** Repository identity carried by an HTTPS, SSH URL, or scp-style git remote. */
export function repositoryFromRemote(value) {
  const remote = String(value ?? "").trim();
  const scp = remote.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
  if (scp && !/^[a-z][a-z\d+.-]*:\/\//i.test(remote)) {
    return normalized(scp[1], scp[2]);
  }

  try {
    const url = new URL(remote);
    return normalized(url.hostname, url.pathname);
  } catch {
    return null;
  }
}

/** Refuse to let a PR URL label operations in an unrelated local checkout. */
export function assertPrCheckout(prUrl, remoteUrl, dir) {
  const target = repositoryFromPrUrl(prUrl);
  if (!target) {
    throw new Error(`cannot identify a pull request repository from "${prUrl}"`);
  }

  const checkout = repositoryFromRemote(remoteUrl);
  if (!checkout) {
    throw new Error(
      `PR targets ${target.display}, but ${dir} has no identifiable origin — ` +
      `run from that repository or pass --dir /path/to/its/checkout`,
    );
  }

  if (checkout.host !== target.host || checkout.path !== target.path) {
    throw new Error(
      `PR targets ${target.display}, but ${dir} is ${checkout.display} — ` +
      `run from the target repository or pass --dir /path/to/${target.path.split("/").at(-1)}`,
    );
  }
}
