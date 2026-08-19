'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  saveDay, getJobs, getTasks, putJob, putTask, enqueue, getOutbox,
  putPhoto, getPhotos, cacheSecret, readSecret, purgeExpiredSecrets, wipeSecrets,
  meta, type Job, type Task, type PendingPhoto, type OutboxAction,
} from '@/lib/tech/store';
import { startSyncLoop, syncNow, getPosition, compressImage } from '@/lib/tech/sync';

type View = { name: 'list' } | { name: 'job'; id: string };

export default function TechApp() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [view, setView] = useState<View>({ name: 'list' });
  const [online, setOnline] = useState(true);
  const [queue, setQueue] = useState<OutboxAction[]>([]);
  const [tech, setTech] = useState<string>('');
  const [booted, setBooted] = useState(false);
  const [signedOut, setSignedOut] = useState(false);

  // The whole queue rather than a count, because the job screen has to be able
  // to say "waiting to send" about THIS job rather than about the day.
  const refreshPending = useCallback(async () => {
    setQueue(await getOutbox());
  }, []);

  const pending = queue.length;

  const loadLocal = useCallback(async () => {
    const [j, t] = await Promise.all([getJobs(), getTasks()]);
    setJobs(j.sort((a, b) => (a.sequence ?? 99) - (b.sequence ?? 99)));
    setTasks(t.sort((a, b) => a.sequence - b.sequence));
  }, []);

  /**
   * Local first, network second.
   *
   * The day renders from IndexedDB before any request is made, so opening the
   * app in a dead zone shows the same thing it showed in the yard. The fetch is
   * a refresh, not a dependency.
   */
  useEffect(() => {
    let cancelled = false;

    (async () => {
      await purgeExpiredSecrets();
      await loadLocal();
      await refreshPending();
      setTech((await meta.get<string>('techName')) ?? '');
      setBooted(true);

      try {
        const res = await fetch('/api/tech/day');
        if (res.status === 401) {
          // The cached day stays on screen - it is this technician's own work
          // and losing it in a driveway helps nobody. The gate codes do not.
          setSignedOut(true);
          await wipeSecrets();
          return;
        }
        if (!res.ok) return;
        setSignedOut(false);
        const data = await res.json();
        if (cancelled) return;
        await saveDay(data.jobs, data.tasks);
        await meta.set('techName', data.technician.name);
        await meta.set('techId', data.technician.id);
        await meta.set('lastSync', new Date().toISOString());
        setTech(data.technician.name);
        await loadLocal();
      } catch {
        // Offline. The local copy is already on screen.
      }
    })();

    return () => { cancelled = true; };
  }, [loadLocal, refreshPending]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    const stop = startSyncLoop((r) => {
      void refreshPending();
      void loadLocal();
      if (r.authRequired) { setSignedOut(true); void wipeSecrets(); }
    });
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
      stop();
    };
  }, [refreshPending, loadLocal]);

  // ── actions: local write first, queue second, network whenever ──────────

  const act = useCallback(async (
    kind: Parameters<typeof enqueue>[0],
    payload: Record<string, unknown>,
  ) => {
    await enqueue(kind, payload);
    await refreshPending();
    void syncNow().then(() => void refreshPending());
  }, [refreshPending]);

  /**
   * A status change, and — when there is one — the reason it could not be
   * finished, in the SAME action.
   *
   * Not a second `job_notes` enqueue afterwards. The outbox orders by
   * `seq = Date.now()`, so two actions queued in the same millisecond tie and
   * can replay in either order; and the server builds the timeline event by
   * re-reading the row it just updated, while the timeline is append-only by
   * trigger. A reason that arrives second can therefore end up permanently
   * missing from the customer's history. One payload removes both races.
   */
  const setStatus = useCallback(async (job: Job, status: string, incompleteReason?: string) => {
    const reason = incompleteReason?.trim() || null;
    const updated = {
      ...job,
      status,
      incomplete_reason: reason ?? job.incomplete_reason ?? null,
      dirty: true,
    };
    await putJob(updated);
    setJobs((prev) => prev.map((j) => (j.id === job.id ? updated : j)));
    await act('job_status', {
      workOrderId: job.id,
      status,
      ...(reason ? { incompleteReason: reason } : {}),
    });

    // A position fix at each meaningful moment. This is what a PWA can do in
    // place of background tracking (ADR 0004) — and it answers the question
    // dispatch actually asks, which is "did the tech get there".
    const pos = await getPosition();
    await act('ping', {
      workOrderId: job.id,
      reason: status,
      lat: pos?.coords.latitude ?? null,
      lng: pos?.coords.longitude ?? null,
      accuracy: pos?.coords.accuracy ?? null,
    });
  }, [act]);

  const toggleTask = useCallback(async (task: Task) => {
    const updated = { ...task, done: !task.done };
    await putTask(updated);
    setTasks((prev) => prev.map((t) => (t.id === task.id ? updated : t)));
    await act('task_toggle', { taskId: task.id, done: updated.done });
  }, [act]);

  const saveNotes = useCallback(async (job: Job, workPerformed: string) => {
    const updated = { ...job, work_performed: workPerformed, dirty: true };
    await putJob(updated);
    setJobs((prev) => prev.map((j) => (j.id === job.id ? updated : j)));
    await act('job_notes', { workOrderId: job.id, workPerformed });
  }, [act]);

  if (!booted) return <div className="t-empty">Loading your day…</div>;

  const current = view.name === 'job' ? jobs.find((j) => j.id === view.id) : null;

  return (
    <div className="t-wrap">
      <header className="t-head">
        <h1>{current ? (current.customer_name) : 'Today'}</h1>
        <div className="sub">
          {current
            ? current.property_label ?? 'Property'
            : `${tech || 'Technician'} · ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}`}
        </div>
        <div className="t-status">
          <span className={`t-dot ${online ? '' : 'off'}`} />
          {online ? 'Online' : 'Offline — your work is saved on this phone'}
          {pending > 0 && ` · ${pending} waiting to send`}
        </div>
      </header>

      {signedOut && (
        <div className="t-offline-banner">
          Signed out. Your work is saved on this phone and will send once you
          sign back in — nothing is lost.
          <a href="/login" style={{ display: 'block', marginTop: 8, textDecoration: 'underline' }}>
            Sign in
          </a>
        </div>
      )}

      {!online && !signedOut && (
        <div className="t-offline-banner">
          No signal. Keep working — everything syncs when you get back in range.
        </div>
      )}

      {current
        ? <JobDetail
            job={current}
            tasks={tasks.filter((t) => t.work_order_id === current.id)}
            queuedForJob={queue.filter((a) => a.payload?.workOrderId === current.id).length}
            onBack={() => setView({ name: 'list' })}
            onStatus={setStatus}
            onToggleTask={toggleTask}
            onSaveNotes={saveNotes}
            onPhotoQueued={refreshPending}
          />
        : <JobList jobs={jobs} tasks={tasks} onOpen={(id) => setView({ name: 'job', id })} />}
    </div>
  );
}

// ── list ───────────────────────────────────────────────────────────────────

function JobList({ jobs, tasks, onOpen }: {
  jobs: Job[]; tasks: Task[]; onOpen: (id: string) => void;
}) {
  if (jobs.length === 0) {
    return (
      <div className="t-empty">
        Nothing scheduled today.
        <br /><br />
        If that looks wrong, pull up on this screen once you have signal.
      </div>
    );
  }

  const done = jobs.filter((j) => j.status === 'complete').length;

  return (
    <>
      <p style={{ color: 'var(--t-dim)', fontSize: 14, margin: '0 0 12px' }}>
        {done} of {jobs.length} done
      </p>

      {jobs.map((j) => {
        const jt = tasks.filter((t) => t.work_order_id === j.id);
        const doneCount = jt.filter((t) => t.done).length;
        return (
          <button
            key={j.id}
            className={`t-job ${j.priority === 'urgent' ? 'urgent' : ''} ${j.status === 'complete' ? 'done' : ''}`}
            onClick={() => onOpen(j.id)}
          >
            <div className="when">{j.scheduled_window ?? 'Anytime'}</div>
            <div className="who">{j.customer_name}</div>
            <div className="where">
              {[j.line1, j.city].filter(Boolean).join(', ') || 'No address'}
              {j.property_label ? ` · ${j.property_label}` : ''}
            </div>
            {j.summary && <div className="what">{j.summary}</div>}
            <div className="t-chips">
              <span className={`t-chip ${j.status === 'complete' ? 'on' : j.status !== 'scheduled' ? 'warn' : ''}`}>
                {j.status.replace('_', ' ')}
              </span>
              {j.priority === 'urgent' && <span className="t-chip warn">urgent</span>}
              <span className="t-chip">{j.type}</span>
              {jt.length > 0 && <span className="t-chip">{doneCount}/{jt.length} steps</span>}
              {j.has_gate_code && <span className="t-chip">gate code</span>}
            </div>
          </button>
        );
      })}
    </>
  );
}

// ── detail ─────────────────────────────────────────────────────────────────

function JobDetail({ job, tasks, queuedForJob, onBack, onStatus, onToggleTask, onSaveNotes, onPhotoQueued }: {
  job: Job;
  tasks: Task[];
  /** How many actions for this job are still sitting in the outbox. */
  queuedForJob: number;
  onBack: () => void;
  onStatus: (job: Job, status: string, incompleteReason?: string) => Promise<void>;
  onToggleTask: (t: Task) => Promise<void>;
  onSaveNotes: (job: Job, notes: string) => Promise<void>;
  onPhotoQueued: () => Promise<void>;
}) {
  const [notes, setNotes] = useState(job.work_performed ?? '');
  const [askingWhy, setAskingWhy] = useState(false);
  const [savedAt, setSavedAt] = useState<string>('');
  const [photos, setPhotos] = useState<PendingPhoto[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reloadPhotos = useCallback(async () => {
    setPhotos((await getPhotos()).filter((p) => p.workOrderId === job.id));
  }, [job.id]);

  useEffect(() => { void reloadPhotos(); }, [reloadPhotos]);

  // Autosave. A tech will not tap "save", and should not have to.
  useEffect(() => {
    if (notes === (job.work_performed ?? '')) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void onSaveNotes(job, notes).then(() =>
        setSavedAt(`Saved ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`));
    }, 900);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [notes, job, onSaveNotes]);

  const mapsHref = [job.line1, job.city, job.state, job.postal_code].filter(Boolean).join(', ');

  async function onPickPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';

    for (const file of files) {
      const blob = await compressImage(file);
      const pos = await getPosition(4000);
      const action = await enqueue('photo', { workOrderId: job.id });
      await putPhoto({
        clientActionId: action.clientActionId,
        workOrderId: job.id,
        propertyId: job.property_id,
        blob,
        capturedAt: new Date().toISOString(),
        lat: pos?.coords.latitude ?? null,
        lng: pos?.coords.longitude ?? null,
        caption: null,
      });
    }

    await reloadPhotos();
    await onPhotoQueued();
    void syncNow().then(() => { void reloadPhotos(); void onPhotoQueued(); });
  }

  return (
    <>
      <button className="t-back" onClick={onBack}>← Today</button>

      <div className="t-card">
        <h2>{job.summary ?? 'Service call'}</h2>
        <div style={{ color: 'var(--t-dim)', fontSize: 15 }}>
          {job.number ? `${job.number} · ` : ''}{job.scheduled_window ?? 'Anytime'}
          {job.estimated_minutes ? ` · ~${job.estimated_minutes} min` : ''}
        </div>

        {job.customer_phone && (
          <a className="t-action" href={`tel:${job.customer_phone.replace(/\D/g, '')}`} style={{ marginTop: 12 }}>
            <span className="ico">📞</span> Call {job.customer_name}
          </a>
        )}
        {mapsHref && (
          <a className="t-action" href={`https://maps.google.com/?q=${encodeURIComponent(mapsHref)}`}
             target="_blank" rel="noreferrer">
            <span className="ico">🧭</span> {mapsHref}
          </a>
        )}
      </div>

      {(job.access_notes || job.pet_notes || job.has_gate_code || job.instructions) && (
        <div className="t-card">
          <h3>Before you get out of the truck</h3>
          {job.instructions && <div className="t-note"><b>From the office</b>{job.instructions}</div>}
          {job.access_notes && <div className="t-note"><b>Access</b>{job.access_notes}</div>}
          {job.pet_notes && <div className="t-note alert"><b>Pets</b>{job.pet_notes}</div>}
          {job.has_gate_code && job.property_id && <GateCode propertyId={job.property_id} />}
        </div>
      )}

      <div className="t-card">
        <h3>Status — now {job.status.replace('_', ' ')}</h3>

        {askingWhy
          ? <WhyPanel
              onCancel={() => setAskingWhy(false)}
              onConfirm={(reason) => {
                // Not awaited on purpose. The write that matters already
                // happened in IndexedDB by the time this resolves, and the tail
                // of onStatus waits on a GPS fix that can take eight seconds in
                // a valley. Nobody stands in the rain watching a spinner.
                void onStatus(job, 'incomplete', reason);
                setAskingWhy(false);
              }}
            />
          : <div className="t-statusbar">
              <button className="t-btn" disabled={job.status === 'en_route'}
                      onClick={() => void onStatus(job, 'en_route')}>On my way</button>
              <button className="t-btn" disabled={job.status === 'on_site'}
                      onClick={() => void onStatus(job, 'on_site')}>I'm here</button>
              <button className="t-btn primary wide" disabled={job.status === 'complete'}
                      onClick={() => void onStatus(job, 'complete')}>Mark complete</button>
              <button className="t-btn wide" disabled={job.status === 'incomplete'}
                      onClick={() => setAskingWhy(true)}>Couldn't finish</button>
            </div>}

        {job.status === 'incomplete' && !askingWhy && (
          <div className="t-note" style={{ marginBottom: 0 }}>
            <b>Why it wasn't finished</b>
            {job.incomplete_reason || 'No reason recorded.'}
            {/* Say which of the two it is. "Saved" and "the office can see it"
                are different facts, and only one of them is true in a dead
                zone. */}
            <div className={`t-sendstate ${queuedForJob > 0 ? 'waiting' : ''}`}>
              {queuedForJob > 0
                ? 'Saved on this phone · waiting to send'
                : 'Sent to the office'}
            </div>
          </div>
        )}
      </div>

      {tasks.length > 0 && (
        <div className="t-card">
          <h3>Checklist — {tasks.filter((t) => t.done).length} of {tasks.length}</h3>
          {tasks.map((t) => (
            <label key={t.id} className={`t-task ${t.done ? 'done' : ''}`}>
              <input type="checkbox" checked={t.done} onChange={() => void onToggleTask(t)} />
              <span>{t.label}</span>
            </label>
          ))}
        </div>
      )}

      <div className="t-card">
        <h3>Photos</h3>
        <input ref={fileRef} type="file" accept="image/*" capture="environment"
               multiple onChange={onPickPhoto} style={{ display: 'none' }} />
        <button className="t-btn primary wide" onClick={() => fileRef.current?.click()}>
          📷 Take a photo
        </button>
        {photos.length > 0 && (
          <div className="t-photos">
            {photos.map((p) => (
              <div className="t-photo" key={p.clientActionId}>
                <img src={URL.createObjectURL(p.blob)} alt="" />
                <div className="pending">waiting to send</div>
              </div>
            ))}
          </div>
        )}
        <p style={{ color: 'var(--t-dim)', fontSize: 13, marginBottom: 0 }}>
          No labelling needed. The job, property, time and place are attached automatically.
        </p>
      </div>

      {/* The only box on the phone that takes free text about a property, and
          therefore the likeliest origin of a gate code in plaintext: the
          sentence that writes itself at a gate that did not open is "code on
          file is wrong, owner says it's now 1234". That would land in
          work_order beside the encrypted column and read back in the office, so
          it is worth one line of type here to head off. */}
      <div className="t-card">
        <h3>What you did</h3>
        <textarea className="t-textarea" value={notes} onChange={(e) => setNotes(e.target.value)}
                  placeholder="Parts used, what you found, what still needs doing…" />
        <p className="t-warnline">
          Never type a gate or lockbox code here. If a code is wrong, call the
          office and they will change it on the property.
        </p>
        <div className="t-saved">{savedAt}</div>
      </div>
    </>
  );
}

/**
 * Why a job could not be finished.
 *
 * The canned list comes first, and it is the mitigation rather than a
 * convenience. The commonest reason a technician cannot finish is that they
 * could not get in, and the sentence that writes itself in a free-text box at a
 * gate that did not open is "code on file is wrong, owner says it's now 1234".
 * That would land in `work_order` as plaintext beside the encrypted column and
 * then, via the status change, onto the timeline — which is append-only by
 * trigger and so can never be redacted. One tap that already says the true
 * thing is what keeps the code out of the sentence. The detail box is the
 * exception rather than the route, and carries the same warning the notes box
 * does.
 *
 * The order is roughly how often these actually happen.
 */
const WHY_REASONS = [
  "Couldn't get in — gate or lock code didn't work",
  'Nobody home',
  'Parts needed',
  'Needs a second tech',
  'Weather — not safe today',
  'Equipment condition — office should call',
  'Something else',
] as const;

function WhyPanel({ onCancel, onConfirm }: {
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [choice, setChoice] = useState<string | null>(null);
  const [detail, setDetail] = useState('');

  const reason = choice ? [choice, detail.trim()].filter(Boolean).join(' — ') : '';

  return (
    <div className="t-why">
      <p className="t-why-ask">Why couldn't you finish?</p>

      <div className="t-reasons">
        {WHY_REASONS.map((r) => (
          <button
            key={r}
            type="button"
            className={`t-reason ${choice === r ? 'on' : ''}`}
            aria-pressed={choice === r}
            onClick={() => setChoice(r)}
          >
            {r}
          </button>
        ))}
      </div>

      <textarea
        className="t-textarea t-why-detail"
        value={detail}
        onChange={(e) => setDetail(e.target.value)}
        placeholder="Anything else the office needs to know (optional)"
      />
      <p className="t-warnline">
        Never type a gate or lockbox code here. If a code is wrong, call the
        office and they will change it on the property.
      </p>

      <div className="t-whybar">
        <button className="t-btn" type="button" onClick={onCancel}>Back</button>
        <button className="t-btn warn" type="button" disabled={!choice}
                onClick={() => onConfirm(reason)}>
          Mark couldn't finish
        </button>
      </div>
      {!choice && <p className="t-why-hint">Pick a reason above — one tap.</p>}
    </div>
  );
}

/**
 * Gate code, fetched on demand and cached only for today (ADR 0003, 0004).
 *
 * On a personal phone this is the difference between holding four codes until
 * tonight and holding every code the company has. Once fetched it stays
 * readable offline for the rest of the day, because the moment a tech actually
 * needs it is standing at a gate with no signal.
 */
function GateCode({ propertyId }: { propertyId: string }) {
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function reveal() {
    setBusy(true);
    setError(null);
    try {
      const cached = await readSecret(propertyId);
      if (cached) { setCode(cached); return; }

      const res = await fetch('/api/gate-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ propertyId }),
      });
      if (res.status === 401) { setError('Sign in to view gate codes'); return; }
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Unavailable'); return; }
      await cacheSecret(propertyId, data.code);
      setCode(data.code);
    } catch {
      setError('No signal, and not saved on this phone yet');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="t-note">
      <b>Gate code</b>
      {code
        ? <div className="t-secret" style={{ textAlign: 'center' }}>{code}</div>
        : <button className="t-secret" onClick={reveal} disabled={busy}>
            {busy ? 'checking…' : 'Show gate code'}
          </button>}
      {error && <div style={{ color: 'var(--t-danger)', fontSize: 14, marginTop: 6 }}>{error}</div>}
    </div>
  );
}
