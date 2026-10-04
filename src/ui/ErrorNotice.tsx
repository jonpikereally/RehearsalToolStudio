import type { CSSProperties, ReactNode } from 'react';
import { errorHover, errorListLink, splitCode } from '../lib/errorCodes';

/**
 * Every error the page shows goes through here: its code beside the message,
 * a link to the public error list, and hover text saying to check that list —
 * so whoever reads it can hand an LLM the code rather than a paraphrase.
 *
 * `text` may carry its own code (one given deeper down, by the engine say);
 * otherwise `code` — the one for where it surfaced — is shown.
 */
export default function ErrorNotice({
  code,
  text,
  children,
  inline = false,
  className = '',
  style,
  role,
}: {
  code: string;
  text?: string | null;
  children?: ReactNode;
  /** A line inside something else, rather than a notice of its own. */
  inline?: boolean;
  className?: string;
  style?: CSSProperties;
  role?: string;
}) {
  const split = text ? splitCode(text) : { code: null, message: '' };
  const shown = split.code ?? code;
  const hover = errorHover(shown);
  const Tag = inline ? 'span' : 'div';
  return (
    <Tag
      className={`${inline ? 'error-text' : 'notice error'} ${className}`.trim()}
      style={style}
      role={role}
      title={hover}
      data-error-code={shown}
    >
      <a className="error-code" href={errorListLink(shown)} target="_blank" rel="noreferrer" title={hover}>
        {shown}
      </a>{' '}
      {text ? split.message : children}
    </Tag>
  );
}
