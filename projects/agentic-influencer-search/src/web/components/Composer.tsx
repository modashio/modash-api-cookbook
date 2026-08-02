import { useState, type FormEvent, type KeyboardEvent } from 'react';

const buttonClass =
  'cursor-pointer rounded-md border-none bg-accent px-5 py-2.5 font-[650] text-bg disabled:cursor-default disabled:opacity-40';

export function Composer({
  busy,
  onSend,
  onStop,
}: {
  busy: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const [value, setValue] = useState('');

  const submit = () => {
    const text = value.trim();
    if (!text || busy) return;
    onSend(text);
    setValue('');
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form
      className="flex items-end gap-2 border-t border-border-soft bg-surface-composer px-6 pt-3.5 pb-5"
      onSubmit={handleSubmit}
    >
      <textarea
        className="max-h-44 flex-1 resize-none rounded-md border border-border bg-bg-input px-3 py-2.5 text-text focus:border-accent focus:outline-none"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={handleKeyDown}
        rows={2}
        placeholder="Describe the campaign, the audience, and any constraints…"
        aria-label="Message"
      />
      {busy ? (
        <button type="button" className={`${buttonClass} bg-border text-text`} onClick={onStop}>
          Stop
        </button>
      ) : (
        <button type="submit" className={buttonClass} disabled={!value.trim()}>
          Search
        </button>
      )}
    </form>
  );
}
