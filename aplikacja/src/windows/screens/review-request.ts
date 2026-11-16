// Inbox form: the author asks colleagues to review their PR.
import { byId, formValues, messageFor, setBusy, setStatus, type Call } from '../ui.js';

/** Handle returned by `mountReviewRequest`. */
export interface ReviewRequestForm { close(): void }

/**
 * Renders one checkbox per colleague.
 *
 * Call: `renderReviewers(people, me)`.
 * Expects: people from `people.list`; `me` = my id (left out).
 * Output: none; labels via `textContent`.
 */
function renderReviewers(people: { osoba: string; github?: string }[], me: string | null): void {
  const box = byId('reviewers');
  const items: HTMLElement[] = people.filter((p) => p.osoba !== me).map((p) => {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = 'reviewer';
    input.value = p.osoba;
    label.append(input, document.createTextNode(p.github ? `${p.osoba} (GitHub: ${p.github})` : p.osoba));
    return label;
  });
  if (!items.length) {
    const none = document.createElement('p');
    none.className = 'hint';
    none.textContent = 'W firmie nie ma jeszcze innych osób.';
    items.push(none);
  }
  box.replaceChildren(box.querySelector('legend')!, ...items);
}

/**
 * Reads the chosen reviewers.
 *
 * Call: `chosenReviewers(form)`.
 * Expects: the review form (read before disabling it).
 * Output: ids of the checked people.
 */
function chosenReviewers(form: HTMLFormElement): string[] {
  return Array.from(form.querySelectorAll<HTMLInputElement>('input[name="reviewer"]:checked')).map((i) => i.value);
}

/**
 * Wires the "Poproś o code review" form.
 *
 * Call: `mountReviewRequest(call, me, onSent)` once.
 * Expects: inbox markup; `me()` returns my person id.
 * Output: a handle; opening loads the people, sending creates the
 * review-request task and calls `onSent` (inbox refresh).
 */
export function mountReviewRequest(call: Call, me: () => string | null, onSent: () => void): ReviewRequestForm {
  const form = byId<HTMLFormElement>('review-form');
  const close = () => {
    form.hidden = true;
    form.reset();
  };
  byId('review-open').addEventListener('click', () => {
    form.hidden = false;
    call('people.list', {}).then((r) => renderReviewers(r.people, me()), (e) => setStatus(messageFor(e), 'error'));
  });
  byId('review-cancel').addEventListener('click', close);
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const values = formValues(form); // before disabling: FormData skips disabled fields
    const reviewers = chosenReviewers(form);
    setBusy(form, true);
    call('review.request', { repo: (values.repo ?? '').trim(), pr: Number((values.pr ?? '').trim()), reviewers })
      .then(() => {
        setStatus(`Wysłano prośbę o code review do: ${reviewers.join(', ')}.`, 'ok');
        close();
        onSent();
      }, (e) => setStatus(messageFor(e), 'error'))
      .finally(() => setBusy(form, false));
  });
  return { close };
}
