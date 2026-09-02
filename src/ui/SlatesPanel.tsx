import { useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { parseAls, type AlsProject } from '../lib/alsParser';
import { readBytes, writeFile } from '../lib/source';
import * as local from '../lib/localSource';
import {
  cueSections,
  defaultVoice,
  HELPER_URL,
  helperVoices,
  slateFileName,
  slateTitles,
  speakable,
  synthesize,
  type HelperVoice,
} from '../lib/slates';
import { buildZip } from '../lib/zip';
import SettingsSection from './SettingsSection';

const LS_VOICE = 'ls.slates.voice';

/**
 * Spoken slates and cues for a set, as files.
 *
 * The set can be the scanned folder's own, or any .als picked off the disk —
 * a set from another artist counts. The voice is the Mac's, reached through
 * the slate helper, because the browser's speech cannot be written to a file
 * (see spokenCues.ts for that story). What comes back is a zip of WAVs, ready
 * to drag onto a cue track.
 */
export default function SlatesPanel() {
  const { lastScan } = useStore();
  const [voices, setVoices] = useState<HelperVoice[] | null>(null);
  const [voice, setVoice] = useState(() => localStorage.getItem(LS_VOICE) ?? '');
  const [project, setProject] = useState<AlsProject | null>(null);
  const [setName, setSetName] = useState<string | null>(null);
  const [custom, setCustom] = useState('');
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Where the set lives in the scanned folder, when it does — that's write access. */
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  const [written, setWritten] = useState<string | null>(null);
  const opened = useRef(false);

  const scanPath = lastScan?.alsSetPaths?.[0] ?? null;

  /** Ask the helper who it can be, once the section is actually looked at. */
  const connect = async () => {
    const found = await helperVoices();
    setVoices(found);
    if (found && !found.some((v) => v.name === voice)) setVoice(defaultVoice(found));
  };
  useEffect(() => {
    if (!opened.current) {
      opened.current = true;
      void connect();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const chooseVoice = (name: string) => {
    setVoice(name);
    try {
      localStorage.setItem(LS_VOICE, name);
    } catch {
      /* not worth failing over */
    }
  };

  const loadScanned = async () => {
    if (!scanPath) return;
    setError(null);
    try {
      const { bytes } = await readBytes(scanPath);
      setProject(await parseAls(bytes));
      setSetName(scanPath.split('/').pop()?.replace(/\.als$/i, '') ?? 'Set');
      setSourcePath(scanPath);
      setWritten(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const pickFile = async () => {
    setError(null);
    try {
      const file = await local.pickFile({ description: 'an Ableton Live set', extensions: ['als'] });
      setProject(await parseAls(file.bytes));
      setSetName(file.name.replace(/\.als$/i, ''));
      // A picked file grants no folder to write into; downloads are the way.
      setSourcePath(null);
      setWritten(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/abort/i.test(message)) setError(message);
    }
  };

  /** Speak each text, zip the WAVs, and hand the zip to the browser. */
  const generate = async (texts: string[], zipName: string) => {
    setError(null);
    try {
      const entries = [];
      for (const [i, text] of texts.entries()) {
        setProgress(`${i + 1} of ${texts.length} — ${text}`);
        entries.push({ name: slateFileName(text), data: await synthesize(speakable(text), voice) });
      }
      download(new Blob([buildZip(entries) as BlobPart], { type: 'application/zip' }), zipName);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setVoices(await helperVoices());
    } finally {
      setProgress(null);
    }
  };

  /**
   * Speak everything the set calls for and file it beside the set, in
   * `Slates/`, ready to drag onto a track in Live. Only offered for the
   * scanned folder's own set, because that is the folder there is a handle to.
   */
  const writeIntoProject = async () => {
    if (!project || !sourcePath) return;
    setError(null);
    setWritten(null);
    try {
      const folder = sourcePath.includes('/') ? sourcePath.slice(0, sourcePath.lastIndexOf('/')) : '';
      const dest = `${folder ? folder + '/' : ''}Slates`;
      const texts = [...slateTitles(project), ...cueSections(project)];
      const seen = new Set<string>();
      let count = 0;
      for (const text of texts) {
        const name = slateFileName(text);
        if (seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());
        setProgress(`${++count} of ${texts.length} — ${text}`);
        const data = await synthesize(speakable(text), voice);
        await writeFile(`${dest}/${name}`, new Blob([data as BlobPart], { type: 'audio/wav' }));
      }
      setWritten(`${count} file${count === 1 ? '' : 's'} in ${dest}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setVoices(await helperVoices());
    } finally {
      setProgress(null);
    }
  };

  const single = async () => {
    setError(null);
    try {
      const data = await synthesize(speakable(custom), voice);
      download(new Blob([data as BlobPart], { type: 'audio/wav' }), slateFileName(custom));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setVoices(await helperVoices());
    }
  };

  const titles = project ? slateTitles(project) : [];
  const sections = project ? cueSections(project) : [];
  const ready = voices !== null && voices.length > 0 && !!voice;

  return (
    <SettingsSection
      id="slates"
      title="Slates and cues"
      summary={project ? `${setName} — ${titles.length} songs` : 'spoken titles as files'}
    >
      <div style={{ color: 'var(--text-dim)', fontSize: 14 }}>
        Speaks song titles and section names into WAV files for a cue track. The voice is this
        Mac's own, so the helper below must be running while you generate.
      </div>

      {voices === null && (
        <div className="notice">
          The helper isn't running. In a terminal, from the project folder:
          <br />
          <span className="code">npm run slates:helper</span>
          <div className="btn-row" style={{ marginTop: 8 }}>
            <button className="btn" onClick={() => void connect()}>
              Look again
            </button>
          </div>
        </div>
      )}

      {ready && (
        <div className="field">
          <label htmlFor="slate-voice">
            Voice
            <span className="hint">
              Premium voices sound best — downloaded in System Settings, Spoken Content.
            </span>
          </label>
          <select id="slate-voice" value={voice} onChange={(e) => chooseVoice(e.target.value)}>
            {voices
              .filter((v) => v.lang.startsWith('en'))
              .map((v) => (
                <option key={v.name} value={v.name}>
                  {v.name}
                </option>
              ))}
          </select>
        </div>
      )}

      <div className="btn-row">
        {scanPath && (
          <button className="btn" onClick={() => void loadScanned()}>
            Use the scanned set
          </button>
        )}
        <button className="btn" onClick={() => void pickFile()}>
          Choose a .als…
        </button>
      </div>

      {project && (
        <div className="btn-row">
          <button
            className="btn primary"
            disabled={!ready || !!progress || !titles.length}
            onClick={() => void generate(titles, `${setName} slates.zip`)}
          >
            {titles.length} title slate{titles.length === 1 ? '' : 's'}
          </button>
          <button
            className="btn"
            disabled={!ready || !!progress || !sections.length}
            onClick={() => void generate(sections, `${setName} cues.zip`)}
          >
            {sections.length ? `${sections.length} section cues` : 'no sections in this set'}
          </button>
          {sourcePath && (
            <button
              className="btn"
              disabled={!ready || !!progress || !titles.length}
              onClick={() => void writeIntoProject()}
            >
              Write into the project
            </button>
          )}
        </div>
      )}

      {written && <div className="notice">{written} — beside the set, ready for a cue track.</div>}

      <div className="field">
        <label htmlFor="slate-custom">
          Anything else
          <span className="hint">One file, saying exactly this.</span>
        </label>
        <div className="btn-row">
          <input
            id="slate-custom"
            type="text"
            value={custom}
            maxLength={200}
            placeholder="Next up…"
            onChange={(e) => setCustom(e.target.value)}
            style={{ flex: 1 }}
          />
          <button className="btn" disabled={!ready || !custom.trim()} onClick={() => void single()}>
            Make slate
          </button>
        </div>
      </div>

      {progress && <div className="notice">{progress}</div>}
      {error && (
        <div className="notice error">
          {error}
          {voices === null && ` — is the helper still running at ${HELPER_URL}?`}
        </div>
      )}
    </SettingsSection>
  );
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  // Long enough for the click to have taken; the tab holds no other handle.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
