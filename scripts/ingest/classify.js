// scripts/ingest/classify.js
// What kind of email this is, decided before any reply (agreed 23 Oct). Claude gives the
// class, a confidence and any reason to hold it for Jon in the same extraction call
// (extract.js); this file normalises them and adds a keyword safety net for the
// "always held for Jon" topics. Used by replies.js.
//
// Classes: submission, question, correction, subscribe, unsubscribe, complaint, spam, other.
// Hold reasons (always held for Jon, even in holiday mode, with a holding reply):
// complaint, data_request (data protection / GDPR), legal_press (legal or press
// enquiries), safeguarding (anything involving children or safeguarding), money (money
// or sponsorship offers), who_runs (questions about who runs the site).
'use strict';

const CLASSES = ['submission', 'question', 'correction', 'subscribe', 'unsubscribe', 'complaint', 'spam', 'other'];
const HOLD_REASONS = ['none', 'complaint', 'data_request', 'legal_press', 'safeguarding', 'money', 'who_runs'];
const HOLD_WORDS = {
  complaint: 'a complaint',
  data_request: 'a data protection request',
  legal_press: 'a legal or press enquiry',
  safeguarding: 'children or safeguarding',
  money: 'a money or sponsorship offer',
  who_runs: 'a question about who runs the site',
};
// Below this, holiday mode asks the sender what they'd like rather than guessing.
const LOW_CLASS_CONFIDENCE = 0.7;

// Safety net for enquiries (never submissions: event listings often mention children,
// donations or sponsored walks). Narrow on purpose: Claude's hold_reason is the main check.
const HOLD_PATTERNS = [
  ['data_request', /\b(gdpr|data protection|subject access|right to be forgotten|(delete|remove|erase) (all )?(my|our) (personal )?(data|details|information))\b/i],
  ['legal_press', /\b(solicitors?|legal action|lawyers?|libel|defamat\w*|journalist|press (enquiry|office|inquiry)|reporter|for (an|a news) article)\b/i],
  ['safeguarding', /\b(safeguarding|child protection)\b/i],
  ['money', /\b(sponsor(ship)?|advertis(e|ing) (with|on|in) (you|the (site|website|newsletter))|paid (post|partnership|placement))\b/i],
  ['who_runs', /\bwho (runs|owns|is behind|are you|writes|edits)\b|\bwho('s| is) (behind|in charge of) (this|the) (site|website|newsletter)\b/i],
];

const str = (v) => (v === undefined || v === null ? '' : String(v).trim());

// Claude's raw tool fields -> { emailClass, classConfidence, holdReason, needsReply, request }.
// Anything invalid becomes "other" with confidence 0, so it is never treated as confident.
function normaliseClass(input = {}) {
  const c = str(input.email_class).toLowerCase();
  const h = str(input.hold_reason).toLowerCase();
  const valid = CLASSES.includes(c);
  return {
    emailClass: valid ? c : 'other',
    classConfidence: valid ? Math.min(1, Math.max(0, Number(input.class_confidence) || 0)) : 0,
    holdReason: HOLD_REASONS.includes(h) ? h : 'none',
    needsReply: input.needs_reply !== false,
    request: str(input.request).replace(/\s+/g, ' ').slice(0, 200),
  };
}

// Hold reason for a planned reply, or ''. Complaints are always held.
function holdReasonFor(cls, holdReason, text) {
  if (cls === 'spam') return '';
  if (holdReason && holdReason !== 'none') return holdReason;
  if (cls === 'complaint') return 'complaint';
  if (cls === 'submission') return '';
  const hit = HOLD_PATTERNS.find(([, re]) => re.test(String(text || '')));
  return hit ? hit[0] : '';
}

// Uncertain enough that holiday mode asks rather than guesses.
const isUncertain = (cls, confidence) => cls === 'other' || !(Number(confidence) >= LOW_CLASS_CONFIDENCE);

module.exports = {
  CLASSES, HOLD_REASONS, HOLD_WORDS, LOW_CLASS_CONFIDENCE, normaliseClass, holdReasonFor, isUncertain,
};
