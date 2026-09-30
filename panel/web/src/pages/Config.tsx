import { useEffect, useState } from 'react';
import { api } from '../api';
import { useApp } from '../app-context';
import { Card, Empty, ErrorBox } from '../components/ui';

/** Lightweight well-formedness check so bad xml never reaches the proxy. */
function xmlError(xml: string): string | null {
  try {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const err = doc.querySelector('parsererror');
    return err ? err.textContent!.trim().split('\n')[0]! : null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export function Config() {
  const { identity } = useApp();
  const [xml, setXml] = useState('');
  const [original, setOriginal] = useState('');
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);

  const reload = () => {
    setBusy(true);
    api
      .config()
      .then((text) => {
        setXml(text);
        setOriginal(text);
        setError(undefined);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  useEffect(reload, []);

  if (!identity.admin) return <Empty>Admin privileges are required to view the configuration.</Empty>;
  if (error) return <ErrorBox error={error} onRetry={reload} />;

  const problem = xml ? xmlError(xml) : null;
  const dirty = xml !== original;

  const save = async () => {
    if (problem) return;
    if (!confirm('Deploy this configuration to the proxy?')) return;
    setBusy(true);
    try {
      const res = await api.saveConfig(xml);
      setNotice(res.message);
      if (res.ok) setOriginal(xml);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="proxy.xml"
      actions={
        <>
          {dirty && <span className="badge badge-warn">unsaved</span>}
          <button className="mini" onClick={reload} disabled={busy}>
            Reload
          </button>
          <button className="mini" onClick={() => setXml(original)} disabled={!dirty}>
            Revert
          </button>
          <button className="mini primary" onClick={save} disabled={busy || !dirty || !!problem}>
            Deploy
          </button>
        </>
      }
    >
      {notice && (
        <div className="notice" onClick={() => setNotice(undefined)}>
          {notice}
        </div>
      )}
      {problem && <div className="errorbox small">{problem}</div>}
      <textarea className="codearea" spellCheck={false} value={xml} onChange={(e) => setXml(e.target.value)} rows={32} />
      <p className="muted small">
        The configuration is deployed through the proxy's <code>/cfgHandler</code> endpoint. Most changes apply live; a few
        (listen ports, cache backend) still need a restart of the proxy node.
      </p>
    </Card>
  );
}
