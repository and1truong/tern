import { useState } from "react";
import { dbApi, type DbSource } from "./dbApi.ts";
import type { ConnectionProfile } from "../shared.ts";
import { buildRedisUrl } from "../datasources/redis/connection.ts";

export function DatabaseOpenModal({ onClose, onOpen, initial = 'sqlite' }: {
  onClose: () => void; onOpen: (source: DbSource) => void; initial?: 'sqlite' | 'postgres' | 'redis';
}) {
  const [kind, setKind] = useState(initial);
  const [path, setPath] = useState('');
  const [create, setCreate] = useState(false);
  const [name, setName] = useState('');
  const [host, setHost] = useState('localhost');
  const [port, setPort] = useState('5432');
  const [database, setDatabase] = useState('postgres');
  const [username, setUsername] = useState('postgres');
  const [password, setPassword] = useState('');
  const [ssl, setSsl] = useState('prefer');
  const [redisHost, setRedisHost] = useState('localhost');
  const [redisPort, setRedisPort] = useState('6379');
  const [redisUser, setRedisUser] = useState('');
  const [redisPassword, setRedisPassword] = useState('');
  const [redisTls, setRedisTls] = useState(false);
  const [redisDb, setRedisDb] = useState('0');
  const [environment, setEnvironment] = useState<ConnectionProfile['environment']>('development');
  const [readOnly, setReadOnly] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const pgUrl = () => {
    const address = new URL(`postgres://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}/${encodeURIComponent(database)}`);
    address.username = username; address.password = password; address.searchParams.set('sslmode', ssl);
    return address.toString();
  };
  const redisUrl = () => buildRedisUrl({
    host: redisHost,
    port: Number(redisPort) || 6379,
    username: redisUser || undefined,
    password: redisPassword || undefined,
    tls: redisTls,
    database: Number(redisDb) || 0,
  });
  const submit = async (test = false) => {
    setBusy(true); setError(''); setMessage('');
    try {
      if (kind === 'sqlite') {
        const target = create ? (await dbApi.create(path)).path : path;
        const opened = await dbApi.open(target);
        onOpen({ kind: 'sqlite', path: opened.path });
      } else if (kind === 'redis') {
        if (test) {
          const info = await dbApi.datasource.test('redis', redisUrl());
          const flavor = info.flavor === 'valkey' ? 'Valkey' : 'Redis';
          setMessage(`Connected: ${flavor} ${info.version} · db ${redisDb || '0'}`);
        } else {
          const c = await dbApi.connections.save('redis', name.trim() || `${redisHost}:${redisPort}`, redisUrl(), environment, readOnly);
          onOpen({ kind: 'redis', connId: c.id, database: String(Number(redisDb) || 0), label: c.label, url: c.url, environment: c.environment, readOnly: c.readOnly });
        }
      } else {
        if (test) {
          const result = await dbApi.connections.test(pgUrl());
          setMessage(`Connected: PostgreSQL ${result.serverVersion} · ${result.database} · ${result.ms} ms`);
        } else {
          const c = await dbApi.connections.save("postgres", name.trim() || `${host}/${database}`, pgUrl(), environment, readOnly);
          onOpen({ kind: 'postgres', connId: c.id, label: c.label, url: c.url, environment: c.environment, readOnly: c.readOnly });
        }
      }
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  return <div className="modal-shade" onKeyDown={e => { if (e.key === 'Escape' && !busy) onClose(); }}>
    <form role="dialog" aria-modal="true" aria-label="Connection manager" className="connection-dialog" onSubmit={e => { e.preventDefault(); void submit(); }}>
      <header className="toolbar"><b>Connection manager</b><button type="button" className="ml-auto" aria-label="Close connection manager" disabled={busy} onClick={onClose}>×</button></header>
      <div className="toolbar"><button type="button" className={kind === 'sqlite' ? 'active' : ''} onClick={() => setKind('sqlite')}>SQLite file</button><button type="button" className={kind === 'postgres' ? 'active' : ''} onClick={() => setKind('postgres')}>PostgreSQL</button><button type="button" className={kind === 'redis' ? 'active' : ''} onClick={() => setKind('redis')}>Redis / Valkey</button></div>
      <div className="form-fields">
        {kind === 'sqlite' ? <>
          <label>Absolute file path<input autoFocus required value={path} onChange={e => setPath(e.target.value)} placeholder="/path/to/database.sqlite" /></label>
          <label className="check"><input type="checkbox" checked={create} onChange={e => setCreate(e.target.checked)} />Create a new SQLite database</label>
          <p>Open a file on this computer. Existing files are never overwritten.</p>
        </> : kind === 'redis' ? <>
          <label>Name<input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="Local cache" /></label>
          <div className="form-row"><label>Host<input required value={redisHost} onChange={e => setRedisHost(e.target.value)} /></label><label>Port<input required type="number" min="1" max="65535" value={redisPort} onChange={e => setRedisPort(e.target.value)} /></label></div>
          <div className="form-row"><label>Username<input value={redisUser} onChange={e => setRedisUser(e.target.value)} placeholder="default" autoComplete="username" /></label><label>Password<input type="password" value={redisPassword} onChange={e => setRedisPassword(e.target.value)} autoComplete="new-password" /></label></div>
          <div className="form-row"><label>Logical database<input required type="number" min="0" max="15" value={redisDb} onChange={e => setRedisDb(e.target.value)} /></label><label>Environment<select value={environment} onChange={e => setEnvironment(e.target.value as typeof environment)}>{['local', 'development', 'staging', 'production'].map(v => <option key={v}>{v}</option>)}</select></label></div>
          <label className="check"><input type="checkbox" checked={redisTls} onChange={e => setRedisTls(e.target.checked)} />Use TLS (rediss://)</label>
          <label className="check"><input type="checkbox" checked={readOnly} onChange={e => setReadOnly(e.target.checked)} />Default to read-only</label>
          <p>Connects to Redis and Valkey servers. Passwords are stored in your OS credential manager through Bun.secrets.</p>
        </> : <>
          <label>Name<input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="Local development" /></label>
          <div className="form-row"><label>Host<input required value={host} onChange={e => setHost(e.target.value)} /></label><label>Port<input required type="number" min="1" max="65535" value={port} onChange={e => setPort(e.target.value)} /></label></div>
          <label>Database<input required value={database} onChange={e => setDatabase(e.target.value)} /></label>
          <div className="form-row"><label>Username<input required value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" /></label><label>Password<input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" /></label></div>
          <div className="form-row"><label>SSL<select value={ssl} onChange={e => setSsl(e.target.value)}>{['disable', 'prefer', 'require', 'verify-ca', 'verify-full'].map(v => <option key={v}>{v}</option>)}</select></label><label>Environment<select value={environment} onChange={e => setEnvironment(e.target.value as typeof environment)}>{['local', 'development', 'staging', 'production'].map(v => <option key={v}>{v}</option>)}</select></label></div>
          <label className="check"><input type="checkbox" checked={readOnly} onChange={e => setReadOnly(e.target.checked)} />Default to read-only</label>
          <p>Passwords are stored in your OS credential manager through Bun.secrets. Saving fails if secure storage is unavailable.</p>
        </>}
        {error && <div role="alert" className="error">{error}</div>}{message && <div role="status" className="text-[var(--success)]">{message}</div>}
      </div>
      <footer className="toolbar justify-end"><button type="button" disabled={busy} onClick={onClose}>Cancel</button>{kind !== 'sqlite' && <button type="button" disabled={busy} onClick={() => void submit(true)}>Test Connection</button>}<button className="primary" disabled={busy}>{busy ? 'Connecting…' : kind !== 'sqlite' ? 'Save & Connect' : create ? 'Create & Open' : 'Open SQLite'}</button></footer>
    </form>
  </div>;
}
