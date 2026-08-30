import { downloadUrl, type ScriptProject } from '@/lib/supabase';
import { Copy, Check, Tag, Sparkles, Loader2, AlertCircle, FileText } from 'lucide-react';
import { useState } from 'react';

/**
 * The YouTube listing for a project: title, description and tags.
 *
 * Shared rather than duplicated because this data was previously rendered only in the
 * Produce tab, inside a panel that disappears as soon as you navigate away — so metadata
 * the pipeline had already generated and paid for was effectively unreachable afterwards.
 */
interface SeoPanelProps {
  project: ScriptProject;
  /** Supplied when the panel should offer to generate missing metadata. */
  onGenerate?: () => Promise<void>;
  generating?: boolean;
  error?: string;
  /** Compact mode drops the outer card, for use inside an existing panel. */
  bare?: boolean;
}

export default function SeoPanel({ project, onGenerate, generating, error, bare }: SeoPanelProps) {
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (label: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  };

  const tags = project.youtube_tags ?? [];
  const hasSeo = Boolean(project.youtube_title || project.youtube_description || tags.length);

  // Everything in one paste, in the order YouTube's upload form asks for it.
  const everything = [
    project.youtube_title,
    '',
    project.youtube_description,
    '',
    tags.join(', '),
  ].join('\n').trim();

  const body = (
    <>
      {/* When nested the surrounding disclosure already names this section, so the heading
          would just be said twice — but the row still has to exist to hold Copy all. */}
      <div className="flex items-center justify-between">
        {bare ? <span /> : (
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-white">
            <FileText className="w-3.5 h-3.5 text-brand-400" />
            YouTube listing
          </h3>
        )}
        {hasSeo && (
          <button
            onClick={() => copy('all', everything)}
            className="flex items-center gap-1 text-xs text-brand-400 hover:text-brand-300 font-medium"
          >
            <Copy className="w-3 h-3" />
            {copied === 'all' ? 'Copied' : 'Copy all'}
          </button>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-error-500/10 border border-error-500/30">
          <AlertCircle className="w-4 h-4 text-error-400 shrink-0 mt-0.5" />
          <p className="text-xs text-error-400">{error}</p>
        </div>
      )}

      {!hasSeo ? (
        <div className="text-center py-6">
          <p className="text-sm text-slate-400 mb-1">No listing yet</p>
          <p className="text-xs text-ink-500 mb-4">
            {onGenerate
              ? 'Generate a title, description and tags from this script.'
              : 'This project was made before listings were generated.'}
          </p>
          {onGenerate && (
            <button
              onClick={onGenerate}
              disabled={generating}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-brand-300 bg-brand-600/15 hover:bg-brand-600/25 transition-colors disabled:opacity-50"
            >
              {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
              {generating ? 'Writing…' : 'Generate listing'}
            </button>
          )}
        </div>
      ) : (
        <>
          <Field
            label="Title"
            value={project.youtube_title}
            copied={copied === 'Title'}
            onCopy={() => copy('Title', project.youtube_title)}
          />
          <Field
            label="Description"
            value={project.youtube_description}
            multiline
            copied={copied === 'Description'}
            onCopy={() => copy('Description', project.youtube_description)}
          />

          {tags.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="flex items-center gap-1.5 text-xs font-medium text-slate-400 uppercase tracking-wide">
                  <Tag className="w-3.5 h-3.5" /> Tags · {tags.length}
                </p>
                <button
                  onClick={() => copy('Tags', tags.join(', '))}
                  className="flex items-center gap-1 text-xs text-brand-400 hover:text-brand-300"
                >
                  <Copy className="w-3 h-3" />
                  {copied === 'Tags' ? 'Copied' : 'Copy'}
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {tags.map((tag) => (
                  <span
                    key={tag}
                    className="px-2 py-1 rounded-md bg-ink-800 border border-ink-700 text-xs text-slate-300"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          )}

          {project.thumbnail_url && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-medium text-slate-400 uppercase tracking-wide">Thumbnail</p>
                <a
                  href={downloadUrl(project.thumbnail_url, `${project.youtube_title || 'video'}-thumbnail`)}
                  className="text-xs text-brand-400 hover:text-brand-300 font-medium"
                >
                  Download
                </a>
              </div>
              <img
                src={project.thumbnail_url}
                alt="Generated thumbnail"
                className="w-full max-w-xs rounded-lg border border-ink-700"
              />
            </div>
          )}
        </>
      )}
    </>
  );

  if (bare) return <div className="space-y-4">{body}</div>;

  return <div className="bg-ink-850 border border-ink-700 rounded-xl p-5 space-y-4">{body}</div>;
}

function Field({
  label,
  value,
  multiline,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  multiline?: boolean;
  copied: boolean;
  onCopy: () => void;
}) {
  if (!value) return null;
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-medium text-slate-400 uppercase tracking-wide">{label}</p>
        <button onClick={onCopy} className="flex items-center gap-1 text-xs text-brand-400 hover:text-brand-300">
          {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div className={`bg-ink-800 border border-ink-700 rounded-lg p-3 ${multiline ? 'max-h-56 overflow-y-auto' : ''}`}>
        <p className="text-sm text-slate-200 whitespace-pre-wrap leading-relaxed">{value}</p>
      </div>
    </div>
  );
}
