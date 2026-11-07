/**
 * Turns the GitHub Actions event that triggered the workflow into a Discord embed and posts it to
 * the `DISCORD_WEBHOOK` secret. No dependency: runs with the Node.js runtime of the runner.
 *
 * Local check without calling Discord:
 *   DISCORD_DRY_RUN=1 GITHUB_EVENT_NAME=push GITHUB_EVENT_PATH=event.json node .github/scripts/discord-notify.mjs
 */
import { readFile } from 'node:fs/promises';

/** Discord embed limits (https://discord.com/developers/docs/resources/message#embed-object-embed-limits). */
const LIMITS = { title: 256, description: 4096, fieldName: 256, fieldValue: 1024, fields: 25, footer: 2048 };
const MAX_LISTED_COMMITS = 10;
const MAX_LISTED_ITEMS = 8;
const COMMIT_SUBJECT_LENGTH = 80;
const BODY_PREVIEW_LENGTH = 600;
const MAX_ATTEMPTS = 3;
const DEFAULT_USERNAME = 'Sky Training Aviation • GitHub';

const COLORS = {
  success: 0x2ea043,
  failure: 0xcf222e,
  info: 0x0969da,
  warning: 0xd29922,
  neutral: 0x6e7781,
  merged: 0x8250df,
  star: 0xe3b341,
  brand: 0x0ea5e9,
};

const ACTION_COLORS = {
  opened: COLORS.success,
  created: COLORS.success,
  published: COLORS.success,
  released: COLORS.success,
  reopened: COLORS.success,
  answered: COLORS.success,
  closed: COLORS.failure,
  deleted: COLORS.failure,
  unpublished: COLORS.failure,
  locked: COLORS.warning,
  dismissed: COLORS.warning,
  converted_to_draft: COLORS.neutral,
};

const STATE_COLORS = {
  success: COLORS.success,
  approved: COLORS.success,
  failure: COLORS.failure,
  error: COLORS.failure,
  changes_requested: COLORS.failure,
  pending: COLORS.warning,
  in_progress: COLORS.warning,
  queued: COLORS.warning,
  inactive: COLORS.neutral,
  commented: COLORS.info,
};

/** Intermediate states that would double every notification. */
const IGNORED_STATUS_STATES = new Set(['pending']);
const IGNORED_DEPLOYMENT_STATES = new Set(['queued', 'pending', 'in_progress']);

const truncate = (text, max) => {
  const value = String(text ?? '').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

const humanize = (value) => String(value ?? '').replaceAll('_', ' ');
const firstLine = (text) => String(text ?? '').split('\n')[0];
const shortSha = (sha) => String(sha ?? '').slice(0, 7);
const refName = (ref) => String(ref ?? '').replace(/^refs\/(heads|tags)\//, '');
const isTagRef = (ref) => String(ref ?? '').startsWith('refs/tags/');
const userLink = (user) => (user ? `[${user.login}](${user.html_url})` : null);
const colorFor = (action) => ACTION_COLORS[action] ?? COLORS.info;
const field = (name, value, inline = true) => (value || value === 0 ? { name, value: String(value), inline } : null);
const preview = (text) => (text ? truncate(text, BODY_PREVIEW_LENGTH) : '');
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

const listNames = (items, key = 'name') => {
  const names = (items ?? []).map((item) => item?.[key]).filter(Boolean);
  const visible = names.slice(0, MAX_LISTED_ITEMS);
  const hidden = names.length - visible.length;
  return [...visible, ...(hidden > 0 ? [`+${hidden}`] : [])].join(', ');
};

const labelList = (labels) => listNames((labels ?? []).map((label) => ({ name: label?.name ? `\`${label.name}\`` : null })));

const actionDetailFields = (payload) => [
  field('Label', payload.label?.name ? `\`${payload.label.name}\`` : null),
  field('Assignee', userLink(payload.assignee)),
  field('Milestone', payload.milestone?.title),
];

/** Unique added / modified / removed files across the pushed commits. */
const pushFileStats = (commits) => {
  const collect = (key) => new Set(commits.flatMap((commit) => commit[key] ?? []));
  const [added, modified, removed] = [collect('added'), collect('modified'), collect('removed')];
  if (added.size + modified.size + removed.size === 0) return null;
  return `+${added.size} added · ~${modified.size} modified · -${removed.size} removed`;
};

const pushAuthors = (commits) =>
  [...new Set(commits.map((commit) => commit.author?.username ?? commit.author?.name).filter(Boolean))].join(', ');

const handlers = {
  push: (p) => {
    if (p.deleted) return null;
    const ref = refName(p.ref);
    if (isTagRef(p.ref)) {
      return {
        title: `🏷️ Tag pushed: ${ref}`,
        url: `${p.repository.html_url}/releases/tag/${encodeURIComponent(ref)}`,
        color: COLORS.success,
        fields: [field('Commit', p.head_commit ? `\`${shortSha(p.head_commit.id)}\` ${truncate(firstLine(p.head_commit.message), COMMIT_SUBJECT_LENGTH)}` : null, false)],
      };
    }
    if (p.created && p.commits.length === 0) return null;

    const commits = p.commits.slice(-MAX_LISTED_COMMITS).map(
      (c) => `[\`${shortSha(c.id)}\`](${c.url}) ${truncate(firstLine(c.message), COMMIT_SUBJECT_LENGTH)} — ${c.author?.username ?? c.author?.name}`,
    );
    const hidden = p.commits.length - commits.length;
    if (hidden > 0) commits.push(`…and ${hidden} more`);
    const isDefaultBranch = ref === p.repository.default_branch;

    return {
      title: `${p.forced ? '⚠️ Force-push' : '📦 Push'} — ${plural(p.commits.length, 'commit')} on ${ref}`,
      url: p.compare,
      description: commits.join('\n'),
      color: p.forced ? COLORS.warning : isDefaultBranch ? COLORS.brand : COLORS.info,
      fields: [
        field('Branch', `\`${ref}\`${isDefaultBranch ? ' (default)' : ''}`),
        field('Authors', pushAuthors(p.commits)),
        field('Files', pushFileStats(p.commits), false),
      ],
    };
  },

  pull_request_target: (p) => {
    const pr = p.pull_request;
    const merged = p.action === 'closed' && pr.merged;
    const actionLabel = merged
      ? 'merged'
      : p.action === 'synchronize'
        ? 'updated with new commits'
        : humanize(p.action);
    const reviewer = p.requested_reviewer?.login ?? p.requested_team?.name;
    const isOpening = p.action === 'opened' || p.action === 'ready_for_review';

    return {
      title: `🔀 PR #${pr.number} ${actionLabel}: ${pr.title}`,
      url: pr.html_url,
      description: isOpening ? preview(pr.body) : '',
      color: merged ? COLORS.merged : pr.draft ? COLORS.neutral : colorFor(p.action),
      fields: [
        field('Branches', `\`${pr.head.ref}\` → \`${pr.base.ref}\``),
        field('Author', userLink(pr.user)),
        field('Merged by', merged ? userLink(pr.merged_by) : null),
        field('Reviewer requested', reviewer),
        field('Draft', pr.draft && isOpening ? 'yes' : null),
        field('Changes', isOpening ? `+${pr.additions} / -${pr.deletions} (${plural(pr.changed_files, 'file')})` : null),
        field('Commits', isOpening || merged ? pr.commits : null),
        field('Labels', isOpening ? labelList(pr.labels) : null),
        ...actionDetailFields(p),
      ],
    };
  },

  pull_request_review: (p) => ({
    title: `👀 Review ${humanize(p.review.state)} on PR #${p.pull_request.number}: ${p.pull_request.title}`,
    url: p.review.html_url,
    description: preview(p.review.body),
    color: STATE_COLORS[p.review.state] ?? colorFor(p.action),
    fields: [field('Action', humanize(p.action)), field('PR author', userLink(p.pull_request.user))],
  }),

  pull_request_review_comment: (p) => ({
    title: `💬 Review comment ${humanize(p.action)} on PR #${p.pull_request.number}: ${p.pull_request.title}`,
    url: p.comment.html_url,
    description: preview(p.comment.body),
    color: colorFor(p.action),
    fields: [field('File', `\`${p.comment.path}\`${p.comment.line ? ` (line ${p.comment.line})` : ''}`)],
  }),

  issues: (p) => ({
    title: `🐛 Issue #${p.issue.number} ${humanize(p.action)}: ${p.issue.title}`,
    url: p.issue.html_url,
    description: p.action === 'opened' ? preview(p.issue.body) : '',
    color: colorFor(p.action),
    fields: [
      field('Author', userLink(p.issue.user)),
      field('Labels', p.action === 'opened' ? labelList(p.issue.labels) : null),
      field('Closed as', p.action === 'closed' ? humanize(p.issue.state_reason) : null),
      ...actionDetailFields(p),
    ],
  }),

  issue_comment: (p) => {
    const kind = p.issue.pull_request ? 'PR' : 'issue';
    return {
      title: `💬 Comment ${humanize(p.action)} on ${kind} #${p.issue.number}: ${p.issue.title}`,
      url: p.comment.html_url,
      description: preview(p.comment.body),
      color: colorFor(p.action),
    };
  },

  discussion: (p) => ({
    title: `🗣️ Discussion #${p.discussion.number} ${humanize(p.action)}: ${p.discussion.title}`,
    url: p.discussion.html_url,
    description: p.action === 'created' ? preview(p.discussion.body) : '',
    color: colorFor(p.action),
    fields: [field('Category', p.discussion.category?.name), field('Label', p.label?.name)],
  }),

  discussion_comment: (p) => ({
    title: `💬 Comment ${humanize(p.action)} on discussion #${p.discussion.number}: ${p.discussion.title}`,
    url: p.comment.html_url,
    description: preview(p.comment.body),
    color: colorFor(p.action),
  }),

  release: (p) => {
    const release = p.release;
    const isAnnouncement = ['published', 'released'].includes(p.action);
    return {
      title: `🚀 Release ${humanize(p.action)}: ${release.name || release.tag_name}`,
      url: release.html_url,
      description: isAnnouncement ? preview(release.body) : '',
      color: colorFor(p.action),
      fields: [
        field('Tag', `\`${release.tag_name}\``),
        field('Pre-release', release.prerelease ? 'yes' : null),
        field('Assets', release.assets?.length ? listNames(release.assets) : null, false),
      ],
    };
  },

  create: (p) => ({
    title: `🌱 ${p.ref_type === 'tag' ? 'Tag' : 'Branch'} created: ${p.ref}`,
    url: `${p.repository.html_url}/tree/${encodeURIComponent(p.ref)}`,
    color: COLORS.success,
  }),

  delete: (p) => ({
    title: `🗑️ ${p.ref_type === 'tag' ? 'Tag' : 'Branch'} deleted: ${p.ref}`,
    url: p.repository.html_url,
    color: COLORS.failure,
  }),

  fork: (p) => ({
    title: `🍴 Repository forked to ${p.forkee.full_name}`,
    url: p.forkee.html_url,
    color: COLORS.neutral,
    fields: [field('Total forks', p.repository.forks_count)],
  }),

  watch: (p) => ({
    title: '⭐ New star',
    url: p.repository.html_url,
    color: COLORS.star,
    fields: [field('Total stars', p.repository.stargazers_count)],
  }),

  public: (p) => ({
    title: '🌍 Repository is now public',
    url: p.repository.html_url,
    color: COLORS.warning,
  }),

  label: (p) => ({
    title: `🏷️ Label ${humanize(p.action)}: ${p.label.name}`,
    url: `${p.repository.html_url}/labels`,
    description: p.label.description ?? '',
    color: Number.parseInt(p.label.color, 16) || colorFor(p.action),
  }),

  milestone: (p) => ({
    title: `🎯 Milestone ${humanize(p.action)}: ${p.milestone.title}`,
    url: p.milestone.html_url,
    description: preview(p.milestone.description),
    color: colorFor(p.action),
    fields: [
      field('Open / closed issues', `${p.milestone.open_issues} / ${p.milestone.closed_issues}`),
      field('Due', p.milestone.due_on ? p.milestone.due_on.slice(0, 10) : null),
    ],
  }),

  deployment: (p) => ({
    title: `🛫 Deployment created for ${p.deployment.environment}`,
    url: `${p.repository.html_url}/deployments`,
    description: p.deployment.description ?? '',
    color: COLORS.warning,
    fields: [field('Ref', `\`${p.deployment.ref}\``), field('Commit', `\`${shortSha(p.deployment.sha)}\``)],
  }),

  deployment_status: (p) => {
    const { state, environment_url: environmentUrl, target_url: targetUrl, log_url: logUrl, description } = p.deployment_status;
    if (IGNORED_DEPLOYMENT_STATES.has(state)) return null;
    const logs = logUrl || targetUrl;
    return {
      title: `${state === 'success' ? '✅' : state === 'failure' || state === 'error' ? '❌' : '🛬'} Deployment ${humanize(state)} — ${p.deployment.environment}`,
      url: environmentUrl || logs || `${p.repository.html_url}/deployments`,
      description: description ?? '',
      color: STATE_COLORS[state] ?? COLORS.info,
      fields: [
        field('Ref', `\`${p.deployment.ref}\``),
        field('Commit', `\`${shortSha(p.deployment.sha)}\``),
        field('URL', environmentUrl ? `[open](${environmentUrl})` : null),
        field('Logs', logs && logs !== environmentUrl ? `[open](${logs})` : null),
      ],
    };
  },

  status: (p) => {
    if (IGNORED_STATUS_STATES.has(p.state)) return null;
    return {
      title: `🚦 ${p.context}: ${humanize(p.state)}`,
      url: p.target_url || p.commit.html_url,
      description: p.description ?? '',
      color: STATE_COLORS[p.state] ?? COLORS.info,
      fields: [
        field('Commit', `[\`${shortSha(p.sha)}\`](${p.commit.html_url}) ${truncate(firstLine(p.commit.commit.message), COMMIT_SUBJECT_LENGTH)}`, false),
        field('Branches', listNames(p.branches)),
      ],
    };
  },

  gollum: (p) => ({
    title: `📚 Wiki updated (${plural(p.pages.length, 'page')})`,
    url: `${p.repository.html_url}/wiki`,
    description: p.pages.map((page) => `${humanize(page.action)}: [${page.title}](${page.html_url})`).join('\n'),
    color: COLORS.info,
  }),

  page_build: (p) => ({
    title: `📄 GitHub Pages build ${humanize(p.build.status)}`,
    url: p.repository.html_url,
    description: p.build.error?.message ?? '',
    color: p.build.status === 'built' ? COLORS.success : COLORS.failure,
  }),

  branch_protection_rule: (p) => ({
    title: `🛡️ Branch protection rule ${humanize(p.action)}: ${p.rule.name}`,
    url: `${p.repository.html_url}/settings/branches`,
    color: COLORS.warning,
  }),

  registry_package: (p) => ({
    title: `📦 Package ${humanize(p.action)}: ${p.registry_package.name}`,
    url: p.registry_package.html_url,
    color: colorFor(p.action),
    fields: [field('Version', p.registry_package.package_version?.version)],
  }),

  merge_group: (p) => ({
    title: '🚂 Merge queue checks requested',
    url: `${p.repository.html_url}/queue/${refName(p.merge_group.base_ref)}`,
    color: COLORS.info,
    fields: [field('Head commit', `\`${shortSha(p.merge_group.head_sha)}\``)],
  }),

  repository_dispatch: (p) => ({
    title: `📡 Repository dispatch: ${p.action}`,
    url: p.repository.html_url,
    description: p.client_payload?.message ? preview(p.client_payload.message) : '',
    color: COLORS.neutral,
  }),

  workflow_dispatch: (p) => ({
    title: '🔔 Discord notifications test',
    url: p.repository.html_url,
    description: process.env.DISCORD_TEST_MESSAGE?.trim() || 'The Discord webhook is correctly configured for this repository.',
    color: COLORS.success,
    fields: [field('Branch', refName(p.ref)), field('Run', process.env.GITHUB_RUN_URL ? `[open](${process.env.GITHUB_RUN_URL})` : null)],
  }),
};

handlers.pull_request = handlers.pull_request_target;

const fallbackHandler = (p, eventName) => ({
  title: `ℹ️ ${humanize(eventName)}${p.action ? ` ${humanize(p.action)}` : ''}`,
  url: p.repository?.html_url,
  color: COLORS.neutral,
});

export const buildEmbed = (eventName, payload) => {
  const handler = handlers[eventName] ?? ((p) => fallbackHandler(p, eventName));
  const content = handler(payload);
  if (!content) return null;

  const repository = payload.repository;
  const sender = payload.sender;
  return {
    title: truncate(content.title, LIMITS.title),
    url: content.url,
    description: truncate(content.description, LIMITS.description) || undefined,
    color: content.color,
    author: sender ? { name: sender.login, url: sender.html_url, icon_url: sender.avatar_url } : undefined,
    fields: (content.fields ?? [])
      .filter(Boolean)
      .slice(0, LIMITS.fields)
      .map((f) => ({ ...f, name: truncate(f.name, LIMITS.fieldName), value: truncate(f.value, LIMITS.fieldValue) })),
    footer: repository
      ? { text: truncate(`${repository.full_name} • ${eventName}`, LIMITS.footer), icon_url: repository.owner?.avatar_url }
      : undefined,
    timestamp: new Date().toISOString(),
  };
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const sendToDiscord = async (webhookUrl, body) => {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const response = await fetch(`${webhookUrl}?wait=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (response.ok) return;

    const details = await response.text();
    const isRetryable = response.status === 429 || response.status >= 500;
    if (isRetryable && attempt < MAX_ATTEMPTS) {
      let retryAfterSeconds = attempt;
      try {
        retryAfterSeconds = Number(JSON.parse(details || '{}').retry_after ?? attempt);
      } catch {
        // Non-JSON error body (5xx HTML page): keep the linear backoff.
      }
      await wait(Math.ceil(retryAfterSeconds * 1000));
      continue;
    }
    throw new Error(`Discord responded with HTTP ${response.status}: ${truncate(details, 500)}`);
  }
};

const main = async () => {
  const webhookUrl = process.env.DISCORD_WEBHOOK?.trim();
  const eventName = process.env.GITHUB_EVENT_NAME;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const isDryRun = process.env.DISCORD_DRY_RUN === '1';

  if (!webhookUrl && !isDryRun) {
    throw new Error('DISCORD_WEBHOOK secret is missing (Settings → Secrets and variables → Actions).');
  }
  if (!eventName || !eventPath) {
    throw new Error('GITHUB_EVENT_NAME and GITHUB_EVENT_PATH must be set by GitHub Actions.');
  }

  const payload = JSON.parse(await readFile(eventPath, 'utf8'));
  const embed = buildEmbed(eventName, payload);
  if (!embed) {
    console.log(`Event "${eventName}" (${payload.action ?? 'no action'}) ignored to limit noise.`);
    return;
  }

  const body = {
    username: process.env.DISCORD_USERNAME?.trim() || DEFAULT_USERNAME,
    avatar_url: process.env.DISCORD_AVATAR_URL?.trim() || undefined,
    allowed_mentions: { parse: [] },
    embeds: [embed],
  };

  if (isDryRun) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }
  await sendToDiscord(webhookUrl, body);
  console.log(`Discord notification sent for "${eventName}".`);
};

main().catch((error) => {
  console.error(`::error::${error.message}`);
  process.exitCode = 1;
});
