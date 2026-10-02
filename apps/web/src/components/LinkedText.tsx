import { linkifyText } from '../lib/text';

/** Plain text with preserved line breaks; http(s) URLs become links. No HTML is ever injected. */
export function LinkedText({ text }: { text: string }) {
  return (
    <p className="body-text announcement-body">
      {linkifyText(text).map((s, i) =>
        s.type === 'link' ? (
          <a key={i} href={s.href} target="_blank" rel="noopener noreferrer">
            {s.text}
          </a>
        ) : (
          s.text
        ),
      )}
    </p>
  );
}
