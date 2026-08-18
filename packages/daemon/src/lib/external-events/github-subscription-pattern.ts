export function legacyGitHubTopic(topic: string): string | null {
  const segments = topic.split('/');
  if (segments.length !== 5 || segments[0] !== 'github') return null;
  const [source, owner, repo, resource, entityAction] = segments;
  const dotIndex = entityAction.indexOf('.');
  if (dotIndex <= 0 || dotIndex === entityAction.length - 1) return null;
  return `${source}/${owner}/${repo}/${resource}.${entityAction.slice(dotIndex + 1)}`;
}

function rejectSlashSeparatedGitHubAction(topic: string): never {
  throw new Error(
    `GitHub topic "${topic}" must use dotted entity actions like "pull_request/42.closed"`
  );
}

const GITHUB_EVENT_RESOURCES = new Set(['pull_request', 'repo']);

function isGitHubEventResource(resource: string): boolean {
  return GITHUB_EVENT_RESOURCES.has(resource);
}

function ensureGitHubEventResource(topic: string, resource: string): void {
  if (resource === '*' || isGitHubEventResource(resource)) return;
  throw new Error(
    `GitHub topic "${topic}" uses unsupported resource "${resource}"; supported resources: ${[...GITHUB_EVENT_RESOURCES].join(', ')}`
  );
}

function splitDottedGitHubResource(segment: string): { resource: string; action: string } | null {
  const dotIndex = segment.indexOf('.');
  if (dotIndex <= 0 || dotIndex === segment.length - 1) return null;
  return { resource: segment.slice(0, dotIndex), action: segment.slice(dotIndex + 1) };
}

function thirdIsOwnerRepoResourceShape(third: string): boolean {
  if (isGitHubEventResource(third)) return true;
  const dotted = splitDottedGitHubResource(third);
  return dotted ? isGitHubEventResource(dotted.resource) : false;
}

function rejectGitHubEntityPatternWithoutAction(topic: string): never {
  throw new Error(
    `GitHub topic "${topic}" must use dotted entity actions like "pull_request/42.opened"`
  );
}

function ensureGitHubEntityAction(topic: string, entityAction: string): void {
  if (entityAction === '*') return;
  const dotIndex = entityAction.indexOf('.');
  if (
    dotIndex <= 0 ||
    dotIndex === entityAction.length - 1 ||
    entityAction.indexOf('.', dotIndex + 1) !== -1
  ) {
    rejectGitHubEntityPatternWithoutAction(topic);
  }
}

export function composeGitHubSubscriptionPattern(source: string, topic: string): string {
  const segments = topic.split('/');
  const isSourcePrefixed = segments[0] === source;
  const resourceSegments = isSourcePrefixed ? segments.slice(1) : segments;
  const firstResourceSegment = resourceSegments[0] ?? '';
  const firstDottedResource = splitDottedGitHubResource(firstResourceSegment);

  if (isSourcePrefixed && segments.length === 6) rejectSlashSeparatedGitHubAction(topic);
  if (!isSourcePrefixed && segments.length === 5) rejectSlashSeparatedGitHubAction(topic);
  if (resourceSegments.length > 4) {
    throw new Error(
      `GitHub topic "${topic}" must match supported shape "owner/repo/pull_request/<id>.<action>"`
    );
  }
  if (isSourcePrefixed && segments.length === 5) {
    ensureGitHubEventResource(topic, segments[3] ?? '');
    ensureGitHubEntityAction(topic, segments[4] ?? '');
    return topic;
  }
  if (resourceSegments.length === 4) {
    ensureGitHubEventResource(topic, resourceSegments[2] ?? '');
    ensureGitHubEntityAction(topic, resourceSegments[3] ?? '');
    return `${source}/${resourceSegments.join('/')}`;
  }
  if (isSourcePrefixed && resourceSegments.length === 3) {
    const [first, second, third] = resourceSegments;
    if (isGitHubEventResource(first ?? '') && !thirdIsOwnerRepoResourceShape(third ?? '')) {
      ensureGitHubEntityAction(topic, `${second}.${third}`);
      return `${source}/*/*/${first}/${second}.${third}`;
    }
    if (isGitHubEventResource(second ?? '') && !thirdIsOwnerRepoResourceShape(third ?? '')) {
      ensureGitHubEntityAction(topic, third ?? '');
      return `${source}/${source}/${first}/${second}/${third}`;
    }
  }
  if (resourceSegments.length === 3) {
    const [owner, repo, resource] = resourceSegments;
    const dotted = splitDottedGitHubResource(resource ?? '');
    if (dotted) {
      ensureGitHubEventResource(topic, dotted.resource);
      return `${source}/${owner}/${repo}/${dotted.resource}/*.${dotted.action}`;
    }
    if (!isGitHubEventResource(resource ?? '')) rejectSlashSeparatedGitHubAction(topic);
    return `${source}/${owner}/${repo}/${resource}/*`;
  }
  if (resourceSegments.length === 2) {
    const [resource, entityAction] = resourceSegments;
    if (!isGitHubEventResource(resource ?? '')) {
      const dottedEntityAction = splitDottedGitHubResource(entityAction ?? '');
      if (isSourcePrefixed && dottedEntityAction) {
        ensureGitHubEventResource(topic, dottedEntityAction.resource);
        return `${source}/${source}/${resource}/${dottedEntityAction.resource}/*.${dottedEntityAction.action}`;
      }
      if (isSourcePrefixed && isGitHubEventResource(entityAction ?? '')) {
        return `${source}/${source}/${resource}/${entityAction}/*`;
      }
      throw new Error(
        `GitHub topic "${topic}" must include a resource segment like "owner/repo/pull_request"`
      );
    }
    ensureGitHubEntityAction(topic, entityAction ?? '');
    return `${source}/*/*/${resource}/${entityAction}`;
  }
  if (resourceSegments.length === 1) {
    if (firstDottedResource) {
      ensureGitHubEventResource(topic, firstDottedResource.resource);
      return `${source}/*/*/${firstDottedResource.resource}/*.${firstDottedResource.action}`;
    }
    ensureGitHubEventResource(topic, firstResourceSegment);
    return `${source}/*/*/${firstResourceSegment}/*`;
  }
  return `${source}/*/*/${topic}`;
}
