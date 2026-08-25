import { useEffect, useState } from 'react'
import { Bot, Check, ChevronRight, CircleAlert, CircleDashed, FileText, Image, Info, ListChecks, MessageCircleQuestion, Terminal } from 'lucide-react'
import type { PublicSessionSnapshot, TranscriptItem } from '../../../shared/models'
import type {
  InteractionAnswer,
  PublicPendingInteraction
} from '../../../shared/acp/interactions'
import { formatActivityLine, formatActivitySummary } from '../../../shared/acp/activity'
import { SafeMarkdown } from './SafeMarkdown'

interface TranscriptProps {
  session: PublicSessionSnapshot
  privacyEnabled: boolean
  onPreviewImage: (request: { src: string; name: string; origin: { x: number; y: number; width: number; height: number } }) => void
  onAnswerPermission: (requestId: string, optionId: string) => void
  onAnswerInteraction: (interactionId: string, answer: InteractionAnswer) => void
}

export function Transcript({ session, privacyEnabled, onPreviewImage, onAnswerPermission, onAnswerInteraction }: TranscriptProps): React.JSX.Element {
  if (session.transcript.length === 0 && !session.pendingPermission && !session.pendingInteraction) {
    return (
      <div className="empty-transcript" data-testid="empty-transcript">
        <div className="empty-glyph"><Bot size={27} /></div>
        <h1>Ready in this project</h1>
        <p>Ask Grok to inspect, plan, build, or explain. File and terminal actions stay visible here.</p>
        <div className="starter-grid">
          <span>Review the current codebase</span>
          <span>Plan a focused change</span>
          <span>Trace a failing test</span>
        </div>
      </div>
    )
  }

  return (
    <div className="transcript" data-testid="transcript" aria-live="polite">
      {session.transcript.map((item) => <TranscriptRow key={item.id} item={item} privacyEnabled={privacyEnabled} onPreviewImage={onPreviewImage} />)}
      {session.pendingPermission ? (
        <section className="permission-card" data-testid="permission-card">
          <div className="permission-icon"><CircleAlert size={17} /></div>
          <div className="permission-copy">
            <strong>{session.pendingPermission.title}</strong>
            {session.pendingPermission.description ? <p>{session.pendingPermission.description}</p> : null}
            <div className="permission-actions">
              {session.pendingPermission.options.map((option) => (
                <button
                  type="button"
                  key={option.id}
                  className={option.intent?.startsWith('allow') ? 'primary-small' : 'secondary-small'}
                  onClick={() => onAnswerPermission(session.pendingPermission!.requestId, option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        </section>
      ) : null}
      {session.pendingInteraction ? (
        <InteractionCard
          key={session.pendingInteraction.interactionId}
          interaction={session.pendingInteraction}
          onAnswer={onAnswerInteraction}
        />
      ) : null}
      {session.status === 'running' ? <WorkingLine /> : null}
    </div>
  )
}

type PreviewImageHandler = (request: { src: string; name: string; origin: { x: number; y: number; width: number; height: number } }) => void

const ATTACHMENT_NOTE = /^Attached (?:image|images|file|files): (.+)$/

/**
 * User text echoes back with the attachment note blocks main added to the
 * prompt. When the message carries attachment metadata, note lines disappear
 * in favor of preview thumbnails; otherwise (older sessions) they render as
 * compact tags. Either way "Attached image: …" stops reading like a path the
 * agent is asked to open — the image bytes travel in the same prompt.
 */
function UserMessageText({
  text,
  attachments,
  privacyEnabled,
  onPreviewImage
}: {
  text: string
  attachments?: readonly { kind: 'file' | 'image'; displayName: string; preview?: string | undefined }[] | undefined
  privacyEnabled: boolean
  onPreviewImage: PreviewImageHandler
}): React.JSX.Element {
  const lines = text.split('\n')
  const hasNotes = lines.some((line) => ATTACHMENT_NOTE.test(line))
  if (!hasNotes && !attachments?.length) {
    return <div className="message-text">{text}</div>
  }
  const plain = lines.filter((line) => !ATTACHMENT_NOTE.test(line)).join('\n').trim()
  return (
    <>
      {plain ? <div className="message-text">{plain}</div> : null}
      {attachments?.length ? (
        <div className="message-attachment-tags">
          {attachments.map((attachment, index) =>
            attachment.kind === 'image' && attachment.preview && !privacyEnabled ? (
              <button
                type="button"
                className="attachment-thumb"
                key={index}
                title={attachment.displayName}
                aria-label={`View ${attachment.displayName}`}
                onClick={(event) => onPreviewImage({
                  src: attachment.preview!,
                  name: attachment.displayName,
                  origin: event.currentTarget.getBoundingClientRect()
                })}
              >
                <img src={attachment.preview} alt={attachment.displayName} draggable={false} />
              </button>
            ) : (
              <span className="message-attachment-tag" key={index}>
                {attachment.kind === 'image' ? <Image size={11} /> : <FileText size={11} />}
                {attachment.displayName}
              </span>
            )
          )}
        </div>
      ) : (
        <div className="message-attachment-tags">
          {lines.filter((line) => ATTACHMENT_NOTE.test(line)).flatMap((line) =>
            (ATTACHMENT_NOTE.exec(line)?.[1] ?? '').split(', ').map((name) => (
              <span className="message-attachment-tag" key={`${line}-${name}`}>
                {line.startsWith('Attached image') ? <Image size={11} /> : <FileText size={11} />}
                {name}
              </span>
            ))
          )}
        </div>
      )}
    </>
  )
}

/**
 * Grok streams the answer only after the model finishes reasoning, and it sends
 * no reasoning text over ACP, so a turn can sit silent for tens of seconds.
 * Counting that wait keeps it readable as work rather than a hang.
 */
function WorkingLine(): React.JSX.Element {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    const startedAt = Date.now()
    const timer = setInterval(() => {
      setSeconds(Math.floor((Date.now() - startedAt) / 1000))
    }, 1000)
    return () => clearInterval(timer)
  }, [])
  return (
    <div className="working-line" data-testid="working-line">
      <CircleDashed size={14} /> Grok is working
      {seconds >= 3 ? <span className="working-elapsed">· {seconds}s</span> : null}
    </div>
  )
}

function InteractionCard({
  interaction,
  onAnswer
}: {
  interaction: PublicPendingInteraction
  onAnswer: (interactionId: string, answer: InteractionAnswer) => void
}): React.JSX.Element {
  return interaction.kind === 'plan'
    ? <PlanInteractionCard interaction={interaction} onAnswer={onAnswer} />
    : <QuestionInteractionCard interaction={interaction} onAnswer={onAnswer} />
}

function PlanInteractionCard({
  interaction,
  onAnswer
}: {
  interaction: Extract<PublicPendingInteraction, { kind: 'plan' }>
  onAnswer: (interactionId: string, answer: InteractionAnswer) => void
}): React.JSX.Element {
  const [feedback, setFeedback] = useState('')
  return (
    <section className="interaction-card plan-review-card" data-testid="plan-review-card">
      <div className="interaction-heading"><ListChecks size={17} /><strong>Plan ready for review</strong></div>
      {interaction.planContent ? <pre className="plan-review-content">{interaction.planContent}</pre> : <p>No plan content was provided.</p>}
      <label className="interaction-feedback">
        Changes or feedback
        <textarea
          data-testid="plan-feedback"
          value={feedback}
          onChange={(event) => setFeedback(event.target.value)}
          maxLength={64 * 1024}
          placeholder="Tell Grok what to revise"
        />
      </label>
      <div className="interaction-actions">
        <button type="button" className="primary-small" onClick={() => onAnswer(interaction.interactionId, { kind: 'plan', decision: 'approved' })}>
          Approve &amp; implement
        </button>
        <button
          type="button"
          className="secondary-small"
          disabled={!feedback.trim()}
          onClick={() => onAnswer(interaction.interactionId, { kind: 'plan', decision: 'cancelled', feedback: feedback.trim() })}
        >
          Request changes
        </button>
        <button type="button" className="secondary-small" onClick={() => onAnswer(interaction.interactionId, { kind: 'plan', decision: 'abandoned' })}>
          Abandon plan
        </button>
      </div>
    </section>
  )
}

interface QuestionDraft {
  optionIds: string[]
  otherText: string
}

function QuestionInteractionCard({
  interaction,
  onAnswer
}: {
  interaction: Extract<PublicPendingInteraction, { kind: 'question' }>
  onAnswer: (interactionId: string, answer: InteractionAnswer) => void
}): React.JSX.Element {
  const [drafts, setDrafts] = useState<Record<string, QuestionDraft>>({})
  const draftFor = (questionId: string): QuestionDraft => drafts[questionId] ?? { optionIds: [], otherText: '' }
  const updateDraft = (questionId: string, draft: QuestionDraft): void => {
    setDrafts((current) => ({ ...current, [questionId]: draft }))
  }
  const isAnswered = (question: Extract<PublicPendingInteraction, { kind: 'question' }>['questions'][number]): boolean => {
    const draft = draftFor(question.id)
    return draft.optionIds.length > 0 && (
      !draft.optionIds.includes(question.otherOptionId) || Boolean(draft.otherText.trim())
    )
  }
  const answeredQuestions = interaction.questions.filter(isAnswered)
  const answers = answeredQuestions.map((question) => {
    const draft = draftFor(question.id)
    return {
      questionId: question.id,
      optionIds: draft.optionIds,
      ...(draft.optionIds.includes(question.otherOptionId)
        ? { otherText: draft.otherText.trim() }
        : {})
    }
  })
  const submit = (action: 'accepted' | 'chat_about_this' | 'skip_interview'): void => {
    onAnswer(interaction.interactionId, {
      kind: 'question',
      action,
      answers
    })
  }
  return (
    <section className="interaction-card question-card" data-testid="question-card">
      <div className="interaction-heading"><MessageCircleQuestion size={17} /><strong>Grok is asking</strong></div>
      {interaction.questions.map((question) => {
        const draft = draftFor(question.id)
        const inputType = question.multiSelect ? 'checkbox' : 'radio'
        return (
          <fieldset key={question.id} data-testid={`question-${question.id}`}>
            <legend>{question.question}</legend>
            {question.options.map((option) => {
              const checked = draft.optionIds.includes(option.id)
              return (
                <label key={option.id} className="question-option">
                  <input
                    type={inputType}
                    name={question.id}
                    value={option.id}
                    checked={checked}
                    onChange={() => {
                      const optionIds = question.multiSelect
                        ? checked
                          ? draft.optionIds.filter((id) => id !== option.id)
                          : [...draft.optionIds, option.id]
                        : [option.id]
                      updateDraft(question.id, {
                        optionIds,
                        otherText: optionIds.includes(question.otherOptionId) ? draft.otherText : ''
                      })
                    }}
                  />
                  <span><strong>{option.label}</strong>{option.description ? <small>{option.description}</small> : null}</span>
                </label>
              )
            })}
            <label className="question-option other-option">
              <input
                type={inputType}
                name={question.id}
                value={question.otherOptionId}
                checked={draft.optionIds.includes(question.otherOptionId)}
                onChange={() => updateDraft(question.id, {
                  optionIds: question.multiSelect && draft.optionIds.includes(question.otherOptionId)
                    ? draft.optionIds.filter((id) => id !== question.otherOptionId)
                    : question.multiSelect
                      ? [...draft.optionIds, question.otherOptionId]
                      : [question.otherOptionId],
                  otherText: draft.otherText
                })}
              />
              <span><strong>Other</strong></span>
            </label>
            {draft.optionIds.includes(question.otherOptionId) ? (
              <input
                className="other-answer-input"
                data-testid={`other-${question.id}`}
                value={draft.otherText}
                onChange={(event) => updateDraft(question.id, { ...draft, otherText: event.target.value })}
                maxLength={20_000}
                placeholder="Type your answer"
                autoFocus
              />
            ) : null}
            {question.options.flatMap((option) =>
              draft.optionIds.includes(option.id) && option.preview
                ? [(
                    <pre className="question-preview" data-testid={`preview-${question.id}-${option.id}`} key={option.id}>
                      {option.preview}
                    </pre>
                  )]
                : []
            )}
          </fieldset>
        )
      })}
      <div className="question-progress" data-testid="question-progress">
        Answered {answeredQuestions.length}/{interaction.questions.length}
      </div>
      <div className="interaction-actions">
        <button type="button" className="primary-small" disabled={answeredQuestions.length === 0} onClick={() => submit('accepted')}>Submit answers</button>
        {interaction.mode === 'plan' ? (
          <>
            <button type="button" className="secondary-small" onClick={() => submit('chat_about_this')}>Chat about this</button>
            <button type="button" className="secondary-small" onClick={() => submit('skip_interview')}>Skip interview</button>
          </>
        ) : null}
        <button type="button" className="secondary-small" onClick={() => onAnswer(interaction.interactionId, { kind: 'question', action: 'cancelled' })}>Cancel</button>
      </div>
    </section>
  )
}

function TranscriptRow({ item, privacyEnabled, onPreviewImage }: { item: TranscriptItem; privacyEnabled: boolean; onPreviewImage: PreviewImageHandler }): React.JSX.Element {
  if (item.kind === 'message') {
    return (
      <article className={`message-row role-${item.role}`} data-kind={item.kind}>
        <div className="message-body">
          <div className="message-label">{item.role === 'user' ? 'You' : 'Grok'}</div>
          {item.role === 'assistant'
            ? <SafeMarkdown source={item.text} />
            : <UserMessageText text={item.text} attachments={item.attachments} privacyEnabled={privacyEnabled} onPreviewImage={onPreviewImage} />}
        </div>
      </article>
    )
  }
  if (item.kind === 'thought') {
    return (
      <details className="thought-row" open={item.streaming}>
        <summary><ChevronRight size={13} /> Reasoning</summary>
        <p>{item.text}</p>
      </details>
    )
  }
  if (item.kind === 'tool') {
    return (
      <section className={`tool-card tool-${item.status}`} data-testid="tool-card">
        <Terminal size={15} />
        <div>
          <strong>{item.title}</strong>
          {item.detail ? <pre>{item.detail}</pre> : null}
        </div>
        <span className="tool-status">
          {item.status === 'completed' ? <Check size={14} /> : <CircleDashed size={14} />}
          {item.status}
        </span>
      </section>
    )
  }
  if (item.kind === 'plan') {
    return (
      <section className="plan-card">
        <div className="card-eyebrow">Plan</div>
        <ol>
          {item.entries.map((entry, index) => (
            <li key={`${entry.text}-${index}`} className={`plan-${entry.status}`}>
              <span>{entry.status === 'completed' ? <Check size={13} /> : index + 1}</span>
              {entry.text}
            </li>
          ))}
        </ol>
      </section>
    )
  }
  if (item.kind === 'activity') {
    const summary = formatActivitySummary(item.entries) || 'Working'
    const label = formatActivityLine(item.entries, item.hookCount)
    return (
      <div
        className={`activity-line${item.isLead ? ' activity-lead' : ''}`}
        data-testid="activity-line"
        role="status"
        aria-label={`Activity: ${label}`}
      >
        <span className="activity-prefix" aria-hidden="true">{item.isLead ? '|' : '>'}</span>
        <span className="activity-spark" aria-hidden="true">✦</span>
        <span className="activity-summary">{summary}</span>
        {item.hookCount > 0 ? (
          <span className="activity-hooks">[hooks: {item.hookCount}]</span>
        ) : null}
      </div>
    )
  }
  if (item.kind === 'notice') {
    return (
      <div className="notice-row" role="status">
        <Info size={15} />
        {item.text}
      </div>
    )
  }
  return (
    <div className="error-row" role="alert">
      <CircleAlert size={15} />
      {item.text}
    </div>
  )
}
