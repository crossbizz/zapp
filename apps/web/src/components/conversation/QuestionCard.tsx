'use client';

import type { ConversationCard } from '@zapp/api-client';
import { useState, type ReactElement, type SyntheticEvent } from 'react';

import { createControlPlaneClient } from '../../lib/api';

type Question = Extract<ConversationCard, { kind: 'question' }>;

export function QuestionCard({ card, organizationId, runId }: {
  readonly card: Question;
  readonly organizationId: string;
  readonly runId: string;
}): ReactElement {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [status, setStatus] = useState('');
  const submit = async (event: SyntheticEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const values = card.questions.map((question) => ({
      questionId: question.questionId,
      answer: custom[question.questionId]?.trim() || answers[question.questionId] || '',
    }));
    if (values.some(({ answer }) => answer.length === 0)) {
      setStatus('Answer every question before continuing.');
      return;
    }
    setStatus('Submitting answers…');
    try {
      await createControlPlaneClient(organizationId).answerConversationCard(runId, {
        version: 1,
        kind: 'question_answers',
        cardId: card.cardId,
        answers: values,
      });
      setStatus('Answers submitted.');
    } catch {
      setStatus('Answers were not submitted. Retry safely.');
    }
  };
  return <form aria-label="Agent questions" className="zapp-conversation-card" onSubmit={(event) => { void submit(event); }}>
    {card.questions.map((question) => <fieldset key={question.questionId}>
      <legend>{question.prompt}</legend>
      {question.options.map((option) => <label key={option.label}>
        <input checked={answers[question.questionId] === option.label && (custom[question.questionId] ?? '') === ''} name={question.questionId} onChange={() => { setAnswers((current) => ({ ...current, [question.questionId]: option.label })); setCustom((current) => ({ ...current, [question.questionId]: '' })); }} type="radio" value={option.label} />
        {option.label}{option.recommended ? ' (Recommended)' : ''} <small>{option.tradeoff}</small>
      </label>)}
      <label>Something else<input aria-label={`${question.prompt} custom answer`} maxLength={20_000} onChange={(event) => { setCustom((current) => ({ ...current, [question.questionId]: event.target.value })); }} value={custom[question.questionId] ?? ''} /></label>
    </fieldset>)}
    <button type="submit">Submit answers</button><p aria-live="polite">{status}</p>
  </form>;
}
