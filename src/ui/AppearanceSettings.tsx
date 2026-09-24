import { useEffect, useState } from 'react';
import SettingsSection from './SettingsSection';
import { ACCENTS, THEMES, currentScheme, onSchemeChange, setScheme } from '../lib/theme';

/** The colour scheme: which surfaces, and which accent. Per machine. */
export default function AppearanceSettings() {
  const [scheme, setLocal] = useState(currentScheme);
  useEffect(() => onSchemeChange(setLocal), []);

  const themeLabel = THEMES.find((t) => t.id === scheme.theme)?.label ?? scheme.theme;
  const accentLabel = ACCENTS.find((a) => a.id === scheme.accent)?.label ?? scheme.accent;

  return (
    <SettingsSection id="appearance" title="Appearance" summary={`${themeLabel} · ${accentLabel}`}>
      <div className="field">
        <label>
          Colour scheme
          <span className="hint">
            Black takes the greys down for a dark room; Light is for a daylit one. Match the Mac
            follows its own light and dark setting.
          </span>
        </label>
        <div className="segmented" role="radiogroup" aria-label="Colour scheme">
          {THEMES.map((t) => (
            <button
              key={t.id}
              role="radio"
              aria-checked={scheme.theme === t.id}
              className={`seg${scheme.theme === t.id ? ' on' : ''}`}
              onClick={() => setScheme({ theme: t.id })}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <label>
          Accent
          <span className="hint">The colour of what is on, playing or chosen.</span>
        </label>
        <div className="swatches" role="radiogroup" aria-label="Accent colour">
          {ACCENTS.map((a) => (
            <button
              key={a.id}
              role="radio"
              aria-checked={scheme.accent === a.id}
              aria-label={a.label}
              title={a.label}
              className={`swatch${scheme.accent === a.id ? ' on' : ''}`}
              style={{ background: a.swatch }}
              onClick={() => setScheme({ accent: a.id })}
            />
          ))}
        </div>
      </div>
    </SettingsSection>
  );
}
