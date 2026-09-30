import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useApp } from '../app-context';
import { Badge, Card, Empty, ErrorBox } from '../components/ui';

/** Well-formedness check so broken xml never reaches the proxy. */
function xmlError(xml: string): string | null {
  try {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const err = doc.querySelector('parsererror');
    return err ? err.textContent!.trim().split('\n')[0]! : null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Very small sanity check for OSCam style ini files. */
function iniError(text: string): string | null {
  let section = '';
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    if (/^\[[^\]]+\]$/.test(line)) {
      section = line;
      continue;
    }
    if (!line.includes('=')) return `Line ${i + 1}: expected "key = value" or a [section] header`;
    if (!section) return `Line ${i + 1}: setting outside of any [section]`;
  }
  return null;
}

export function Config() {
  const { identity, meta } = useApp();
  const [file, setFile] = useState(meta.configFiles[0] ?? 'proxy.xml');
  const [text, setText] = useState('');
  const [original, setOriginal] = useState('');
  const [writable, setWritable] = useState(true);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);

  const reload = useCallback(
    (target = file) => {
      setBusy(true);
      api
        .config(target)
        .then((res) => {
          setText(res.content);
          setOriginal(res.content);
          setWritable(res.writable);
          setError(undefined);
        })
        .catch((err) => setError(err instanceof Error ? err.message : String(err)))
        .finally(() => setBusy(false));
    },
    [file],
  );

  useEffect(() => {
    reload(file);
  }, [file, reload]);

  if (!identity.admin) return <Empty>Admin privileges are required to view the configuration.</Empty>;
  if (error) return <ErrorBox error={error} onRetry={() => reload()} />;

  const problem = text ? (meta.configFormat === 'xml' ? xmlError(text) : iniError(text)) : null;
  const dirty = text !== original;

  const save = async () => {
    if (problem) return;
    if (!confirm(`Deploy ${file} to ${meta.kind === 'oscam' ? 'OSCam' : 'the proxy'}?`)) return;
    setBusy(true);
    try {
      const res = await api.saveConfig(text, file);
      setNotice(res.message);
      if (res.ok) setOriginal(text);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={
        meta.configFiles.length > 1 ? (
          <select className="mini-select" value={file} onChange={(e) => setFile(e.target.value)}>
            {meta.configFiles.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        ) : (
          file
        )
      }
      actions={
        <>
          {!writable && <Badge tone="warn">read-only</Badge>}
          {dirty && <Badge tone="warn">unsaved</Badge>}
          <button className="mini" onClick={() => reload()} disabled={busy}>
            Reload
          </button>
          <button className="mini" onClick={() => setText(original)} disabled={!dirty}>
            Revert
          </button>
          <button className="mini primary" onClick={save} disabled={busy || !dirty || !!problem || !writable}>
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
      <textarea className="codearea" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} rows={32} />
      <p className="muted small">
        {meta.kind === 'oscam' ? (
          <>
            Written through the OSCam web API (<code>part=files&amp;action=Save</code>). Most settings apply live; ports,
            protocols and reader definitions need <em>Restart OSCam</em> from the Admin page.
          </>
        ) : (
          <>
            Deployed through the proxy's <code>/cfgHandler</code> endpoint. Most changes apply live; a few (listen ports,
            cache backend) still need a restart of the proxy node.
          </>
        )}
      </p>
    </Card>
  );
}
