// Central topic registry. A "topic" groups a set of sub-blogs.
// Used by the homepage topic menu and the /topic/[slug] grid pages.

export interface SubBlog {
  id: string;
  title: string;
  excerpt: string;
  date: string;
  readTime: string;
  category: string;
  emoji: string;
  link: string;
  /** Optional punchy one-liner mnemonic for quick understanding. */
  tagline?: string;
}

export interface Topic {
  slug: string;
  name: string;
  emoji: string;
  tagline: string;
  /** The single representative post shown on the homepage. */
  hub: string;
  posts: SubBlog[];
}

export const topics: Topic[] = [
  {
    slug: 'rag',
    name: 'RAG',
    emoji: '🧗',
    tagline: 'Retrieval-Augmented Generation, built naive and improved one measured step at a time — Novice to Ninja.',
    hub: '/blog/rag-the-whole-story',
    posts: [
      {
        id: 'rag-the-whole-story',
        title: 'How RAG actually works, start to finish',
        excerpt: 'The map for the whole series: a naive RAG system improved one idea at a time, every step measured on the same hard test. Start here.',
        date: 'June 25, 2026',
        readTime: '15 min read',
        category: 'Overview',
        emoji: '🧗',
        link: '/blog/rag-the-whole-story',
      },
      {
        id: 'rag-measuring-rag',
        title: 'How do you actually measure a RAG system?',
        excerpt: 'The scorecard the whole series leans on — split RAG into retrieval and generation and score four meaning-aware metrics on a frozen golden set.',
        date: 'June 10, 2026',
        readTime: '12 min read',
        category: 'Evaluation',
        emoji: '📐',
        link: '/blog/rag-measuring-rag',
      },
      {
        id: 'rag-chunking',
        title: 'How does chunking change RAG?',
        excerpt: 'The quietest knob in RAG and the cheapest improvement in the series. Change nothing but the size of the pieces, and beat the baseline on every metric.',
        date: 'June 12, 2026',
        readTime: '10 min read',
        category: 'Indexing',
        emoji: '✂️',
        link: '/blog/rag-chunking',
      },
      {
        id: 'rag-hybrid-search',
        title: 'How does hybrid search work?',
        excerpt: 'Two retrievers — meaning and exact words — fused into one ranking. On this corpus the recipe did not win the way the textbooks promise.',
        date: 'June 14, 2026',
        readTime: '11 min read',
        category: 'Retrieval',
        emoji: '🔀',
        link: '/blog/rag-hybrid-search',
      },
      {
        id: 'rag-reranking',
        title: 'How does a reranker work?',
        excerpt: 'A slow, careful second reader that reorders the shortlist — and the one thing it fundamentally cannot do, proved with real numbers.',
        date: 'June 16, 2026',
        readTime: '13 min read',
        category: 'Retrieval',
        emoji: '🎯',
        link: '/blog/rag-reranking',
      },
      {
        id: 'rag-query-rewriting',
        title: 'How query rewriting helps (and hurts)',
        excerpt: 'When ranking cannot help, change the question itself. Recall finally broke its plateau — with a latency bill worth being honest about.',
        date: 'June 18, 2026',
        readTime: '11 min read',
        category: 'Retrieval',
        emoji: '🗺️',
        link: '/blog/rag-query-rewriting',
      },
      {
        id: 'rag-contextual-retrieval',
        title: 'How does contextual retrieval work?',
        excerpt: 'Glue a one-line "you are here" note to each chunk before embedding. The biggest win in the series — and it let us delete a whole component.',
        date: 'June 20, 2026',
        readTime: '12 min read',
        category: 'Indexing',
        emoji: '🧩',
        link: '/blog/rag-contextual-retrieval',
      },
      {
        id: 'rag-semantic-cache',
        title: 'How does a semantic cache work?',
        excerpt: 'Answer once, serve instantly. Cut average latency 92% on repeated questions without touching accuracy — and one knife-edge setting to watch.',
        date: 'June 22, 2026',
        readTime: '11 min read',
        category: 'Serving',
        emoji: '⚡',
        link: '/blog/rag-semantic-cache',
      },
    ],
  },
  {
    slug: 'measurements',
    name: 'Measurements',
    emoji: '📏',
    tagline: 'The four metrics that tell you whether a RAG or LLM system actually works — each one explained on its own.',
    hub: '/blog/measure-recall',
    posts: [
      {
        id: 'measure-recall',
        title: 'What is Context Recall?',
        excerpt: 'Of all the facts the right answer needs, how many did retrieval fetch? Recall is the ceiling everything else sits under.',
        date: 'June 27, 2026',
        readTime: '7 min read',
        category: 'Retrieval metric',
        emoji: '🎣',
        link: '/blog/measure-recall',
        tagline: "Don't miss the good stuff.",
      },
      {
        id: 'measure-precision',
        title: 'What is Context Precision?',
        excerpt: 'You fetched the right chunk — but is it near the top where the model reads, or buried under noise? That is precision.',
        date: 'June 27, 2026',
        readTime: '7 min read',
        category: 'Retrieval metric',
        emoji: '🔝',
        link: '/blog/measure-precision',
        tagline: "Don't bring the junk.",
      },
      {
        id: 'measure-faithfulness',
        title: 'What is Faithfulness?',
        excerpt: 'Did the answer stick to what was retrieved, or quietly invent some of it? Faithfulness is your hallucination detector.',
        date: 'June 27, 2026',
        readTime: '7 min read',
        category: 'Generation metric',
        emoji: '🪢',
        link: '/blog/measure-faithfulness',
        tagline: "Don't make it up.",
      },
      {
        id: 'measure-answer-relevancy',
        title: 'What is Answer Relevancy?',
        excerpt: 'A response can be perfectly grounded in real context and still answer the wrong question. Relevancy catches the helpful-sounding miss.',
        date: 'June 27, 2026',
        readTime: '7 min read',
        category: 'Generation metric',
        emoji: '🎯',
        link: '/blog/measure-answer-relevancy',
        tagline: 'Answer the actual question.',
      },
    ],
  },
];

export const getTopic = (slug: string) => topics.find((t) => t.slug === slug);
