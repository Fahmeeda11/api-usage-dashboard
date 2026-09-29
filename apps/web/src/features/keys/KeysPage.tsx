import { useState } from 'react';
import { Link } from 'react-router-dom';
import { API_KEY_SCOPES, SCOPE_DESCRIPTIONS, type ApiKeyScope, type CreatedApiKey } from '@usage/shared';
import { useApiKeys, useCreateApiKey, useRevokeApiKey } from '../dashboard/queries.js';
import { Button, EmptyState, ErrorBanner, Field, Input, Spinner } from '../../components/ui.js';
import { useAuth } from '../../lib/auth.js';

function formatDate(value: Date | string | null): string {
  if (!value) return 'never';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value));
}

export function KeysPage() {
  const { logout } = useAuth();
  const { data: keys, isPending } = useApiKeys();
  const createKey = useCreateApiKey();
  const revokeKey = useRevokeApiKey();

  const [label, setLabel] = useState('');
  const [scopes, setScopes] = useState<ApiKeyScope[]>(['ingest']);
  const [justCreated, setJustCreated] = useState<CreatedApiKey | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleCreate(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!label.trim()) return;

    const result = await createKey.mutateAsync({ label: label.trim(), scopes });
    setJustCreated(result.key);
    setLabel('');
    setCopied(false);
  }

  async function copySecret(): Promise<void> {
    if (!justCreated) return;
    try {
      await navigator.clipboard.writeText(justCreated.secret);
      setCopied(true);
    } catch {
      // Clipboard access can be denied; the value is on screen and selectable.
    }
  }

  return (
    <div className="min-h-dvh">
      <header className="flex items-center gap-4 border-b border-slate-200 px-6 py-3 dark:border-slate-800">
        <h1 className="text-lg font-semibold tracking-tight">API Usage</h1>
        <nav className="ml-4">
          <Link
            to="/dashboard"
            className="text-sm font-medium text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
          >
            Dashboard
          </Link>
        </nav>
        <Button variant="ghost" className="ml-auto" onClick={() => void logout()}>
          Sign out
        </Button>
      </header>

      <main className="mx-auto max-w-3xl space-y-6 p-6">
        {/*
          The one and only time this secret is visible. The server stores a
          SHA-256 hash and there is no endpoint that can show it again - so this
          banner is deliberately loud and does not auto-dismiss.
        */}
        {justCreated && (
          <div className="rounded-xl bg-amber-50 p-4 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:ring-amber-900">
            <h2 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
              Copy this key now — it cannot be shown again
            </h2>
            <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">
              Only a hash is stored. If you lose it, revoke the key and create another.
            </p>
            <div className="mt-3 flex items-center gap-2">
              <code className="flex-1 overflow-x-auto rounded-lg bg-white px-3 py-2 font-mono text-xs break-all dark:bg-slate-900">
                {justCreated.secret}
              </code>
              <Button variant="secondary" onClick={() => void copySecret()}>
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <button
              type="button"
              onClick={() => setJustCreated(null)}
              className="mt-3 text-xs font-medium text-amber-900 underline dark:text-amber-200"
            >
              I have saved it
            </button>
          </div>
        )}

        <section className="rounded-xl bg-white p-5 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
          <h2 className="text-sm font-semibold">Create a key</h2>

          <form onSubmit={handleCreate} className="mt-4 space-y-4">
            {createKey.isError && <ErrorBanner message={createKey.error.message} />}

            <Field label="Label" htmlFor="label" hint="What will use this key?">
              <Input
                id="label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="production-rag-system"
              />
            </Field>

            <fieldset>
              <legend className="mb-1.5 text-sm font-medium text-slate-700 dark:text-slate-300">
                Scopes
              </legend>
              <div className="space-y-1.5">
                {API_KEY_SCOPES.map((scope) => (
                  <label key={scope} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={scopes.includes(scope)}
                      onChange={(e) =>
                        setScopes((current) =>
                          e.target.checked
                            ? [...current, scope]
                            : current.filter((s) => s !== scope),
                        )
                      }
                      className="rounded border-slate-300 dark:border-slate-600"
                    />
                    <span className="font-mono text-xs">{scope}</span>
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      {SCOPE_DESCRIPTIONS[scope]}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <Button
              type="submit"
              isLoading={createKey.isPending}
              disabled={!label.trim() || scopes.length === 0}
            >
              Create key
            </Button>
          </form>
        </section>

        <section>
          <h2 className="mb-3 text-sm font-semibold">Your keys</h2>

          {isPending ? (
            <Spinner className="text-slate-400" />
          ) : !keys || keys.length === 0 ? (
            <EmptyState
              title="No keys yet"
              description="Create one above, then POST usage events to /v1/events."
            />
          ) : (
            <ul className="space-y-2">
              {keys.map((key) => (
                <li
                  key={key.id}
                  className="flex items-center gap-4 rounded-xl bg-white p-4 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {key.label}
                      {key.revokedAt && (
                        <span className="ml-2 text-xs font-normal text-status-critical">
                          revoked
                        </span>
                      )}
                    </p>
                    <p className="mt-0.5 font-mono text-xs text-slate-500 dark:text-slate-400">
                      {key.prefix}…
                    </p>
                    <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
                      {key.scopes.join(', ')} · created {formatDate(key.createdAt)} · last used{' '}
                      {formatDate(key.lastUsedAt)}
                    </p>
                  </div>

                  {!key.revokedAt && (
                    <Button
                      variant="danger"
                      className="ml-auto"
                      isLoading={revokeKey.isPending}
                      onClick={() => revokeKey.mutate(key.id)}
                    >
                      Revoke
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-xl bg-slate-100 p-5 dark:bg-slate-900/60">
          <h2 className="text-sm font-semibold">Sending events</h2>
          <pre className="mt-3 overflow-x-auto rounded-lg bg-slate-900 p-3 font-mono text-[11px] leading-relaxed text-slate-300">
{`curl -X POST http://localhost:4000/v1/events \\
  -H "Authorization: Bearer usg_your_key" \\
  -H "Content-Type: application/json" \\
  -d '{"events":[{
    "project":"rag-pipeline",
    "provider":"anthropic",
    "model":"claude-opus-5",
    "promptTokens":1500,
    "completionTokens":300,
    "costUsd":0.0234,
    "latencyMs":1850,
    "status":"ok"
  }]}'`}
          </pre>
          <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
            Ready-made TypeScript and Python clients are in{' '}
            <code className="font-mono">examples/</code> in the repo.
          </p>
        </section>
      </main>
    </div>
  );
}
