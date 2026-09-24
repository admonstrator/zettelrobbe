/**
 * What the two review pages say about themselves: what a run does, why each
 * step exists, and how the tools under the assistant are used once it is
 * done. Plain data, one object per page, so both pages speak alike and one
 * test reads every sentence.
 *
 * The voice (tests/test-review-voice.js): no first person, nobody addressed,
 * no "AI", no reassurance, no dashes. An instruction is an imperative.
 */

export const DUPLICATES_GUIDE = Object.freeze({
  start: {
    title: 'Merge tags and correspondents that mean the same thing.',
    what: 'A scan pairs names by spelling, the model judges every pair on its documents, and each proposal lands below as a tick. Nothing is written before Merge.',
    whatWithoutModel:
      'A scan pairs names by spelling, and each pair lands below as a tick. Nothing is written before Merge.',
    button: 'Find duplicates',
  },
  /** The steps of a run, in order; a page drops the ones a run skips. */
  steps: [
    { key: 'scanning', label: 'Compare names' },
    { key: 'evidence', label: 'Read documents' },
    { key: 'sweeping', label: 'Look for synonyms' },
    { key: 'warming-up', label: 'Measure the model' },
    { key: 'judging', label: 'Judge pairs' },
    { key: 'escalating', label: 'Ask again with excerpts' },
    { key: 'finishing', label: 'Result' },
  ],
  /** What happens in a phase, and why the phase exists. */
  phases: {
    starting: { what: 'Getting ready.', why: '' },
    scanning: {
      what: 'Every name is compared with every other by spelling: case, umlauts, legal forms, plurals, word order, typos.',
      why: 'It costs nothing and finds most duplicates; what spelling cannot tell apart is what the model is for.',
    },
    evidence: {
      what: 'For every pair, the titles of a few documents and the names usually filed with each one are read from Paperless-ngx.',
      why: 'The model judges what is filed under a name, not how the name is spelled.',
    },
    sweeping: {
      what: 'The model reads the whole list of names and points out synonyms, translations and abbreviations.',
      why: 'Spelling cannot see that KFZ and Auto are one thing. A pair from here is a claim, checked like every other pair and never ticked without a second sign.',
    },
    'warming-up': {
      what: 'One small request, to measure how fast the model answers and how many pairs fit into one request.',
      why: 'The rest of the run is sized from it.',
    },
    judging: {
      what: 'The model reads pairs of names with their evidence and says for each whether both mean the same thing, how sure it is, and why.',
      why: 'A pair the scan found by spelling alone becomes a proposal only when the model agrees.',
    },
    escalating: {
      what: 'The pairs the model was unsure about, asked again with excerpts from the documents.',
      why: 'An excerpt settles what a title cannot.',
    },
    finishing: {
      what: 'The answers are sorted into groups; what both the scan and the model settled comes up ticked.',
      why: '',
    },
    applying: {
      what: 'Documents move to the name that stays; the other name is deleted once it is empty.',
      why: 'Every merge is logged and can be undone.',
    },
  },
  /** How the tools below are used once the run is done. */
  done: {
    next: [
      'Every tick below is a proposal: a pair both the scan and the model settled. Untick a group to keep its names apart.',
      'Open a group to choose the name that stays; the documents of the other names move to it.',
      'Unsure groups start unticked. "Review one by one" walks through them with the evidence.',
      '"Merge" writes the ticked groups. "Not a duplicate" keeps a pair out of later scans.',
    ],
  },
  /** One line under the head of each tool. */
  sections: {
    controls:
      'How alike two names must be for the scan to pair them, and whether hidden pairs are shown again.',
    groups:
      'Every group the scan found, most alike first. The tick is the proposal; the chip says why the names were paired.',
    manual: 'Pair any two names by hand when the scan did not.',
    unused:
      'Tags and correspondents no document uses. Ticked, they are deleted with the merge.',
    log: 'Every merge and deletion, with Undo.',
    mappings:
      'Names document analysis mapped onto an existing tag or correspondent instead of creating a near-duplicate.',
    dismissals:
      'Pairs marked "Not a duplicate". They stay out of later scans until shown again.',
    memory:
      'What the model answered before is reused on the next run; clearing it asks everything again.',
  },
});

export const SIMPLIFY_GUIDE = Object.freeze({
  start: {
    title: 'Split compound tags into a document type and topics.',
    what: 'Every tag gets one proposal: split into a type and topics, merge into another tag, delete, or keep. The proposals land below, the sure ones ticked. Nothing is written before Apply.',
    whatWithoutModel:
      'Every tag gets one proposal from the model: split into a type and topics, merge into another tag, delete, or keep. A run needs a model; set one up in Settings.',
    button: 'Simplify tags',
  },
  steps: [
    { key: 'vocabulary', label: 'Propose a vocabulary' },
    { key: 'warming-up', label: 'Measure the model' },
    { key: 'ordering', label: 'Sort every tag' },
    { key: 'finishing', label: 'Result' },
  ],
  phases: {
    starting: { what: 'Getting ready.', why: '' },
    vocabulary: {
      what: 'The model reads every tag name and proposes the document types and topics the archive keeps coming back to.',
      why: 'The order is only as good as the words it may use. The new vocabulary replaces the saved one.',
    },
    'warming-up': {
      what: 'One small request, to measure how fast the model answers and how many tags fit into one request.',
      why: 'The rest of the run is sized from it.',
    },
    ordering: {
      what: 'The model reads the tag names, with the number of documents on each, and says for every tag what it is: a type plus topics, another spelling of another tag, a leftover to delete, or a tag to keep.',
      why: 'It judges by the name alone and never opens a document. A rule settled the plain cases before; what the model was unsure about starts unticked.',
    },
    splitting: {
      what: 'The model reads the compound tag names and splits each into a type and topics of the vocabulary.',
      why: 'It judges by the name alone and never opens a document. A rule settled the plain cases before.',
    },
    finishing: {
      what: 'The proposals are sorted into groups by what a tag becomes; what the model was sure of, and what a rule settled, comes up ticked.',
      why: '',
    },
    applying: {
      what: 'Each ticked tag is written: its documents get the type and the topics or move to the other tag, and the old tag is deleted once no document carries it.',
      why: 'Every apply is logged on the Duplicates page and can be undone there.',
    },
  },
  done: {
    next: [
      'Every tick below is a proposal: what the model was sure of, or a rule settled. Untick a tag to leave it as it is.',
      'Unsure tags start unticked. "Review one by one" shows them one at a time, with what each one writes.',
      'The table shows every tag as a row, where the type and the topics can be changed before they are written.',
      '"Apply" writes the ticked proposals. "Skip" puts a tag aside until it is reopened.',
    ],
  },
  sections: {
    order:
      'One proposal per tag, grouped by what it becomes; the tick is the proposal. Filter by kind and status, search by name.',
    vocabulary:
      'The document types and topics the proposals may use. Edit it and propose the order again.',
    table:
      'Every tag as one row: what it becomes, why, and its status. The type and the topics can be changed here.',
  },
});
