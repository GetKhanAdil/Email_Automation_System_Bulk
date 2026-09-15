import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api.js";
import { useToast } from "../lib/toast.jsx";
import {
  IconReply, IconSend, IconCheck, IconX, IconClock, IconSearch,
} from "../components/Icons.jsx";

const TABS = [
  { key: "due", label: "Follow-up due" },
  { key: "replied", label: "Replied" },
  { key: "awaiting", label: "Awaiting" },
];

function fmt(dt) {
  if (!dt) return "—";
  const d = new Date(dt.replace(" ", "T") + (dt.includes("Z") ? "" : "Z"));
  if (isNaN(d)) return dt;
  return d.toLocaleString(undefined, {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
  });
}

function Stat({ label, value, tone = "slate", hint }) {
  const tones = {
    slate: "text-slate-800 dark:text-slate-100",
    green: "text-green-600 dark:text-green-400",
    amber: "text-amber-600 dark:text-amber-400",
    blue: "text-blue-600 dark:text-blue-400",
  };
  return (
    <div className="card p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-extrabold ${tones[tone]}`}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-slate-400">{hint}</div>}
    </div>
  );
}

export default function FollowUps() {
  const toast = useToast();
  const navigate = useNavigate();

  const [summary, setSummary] = useState(null);
  const [tab, setTab] = useState("due");
  const [days, setDays] = useState(7);
  const [rows, setRows] = useState([]);
  const [selected, setSelected] = useState(() => new Set());
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [thread, setThread] = useState(null);
  const [suggesting, setSuggesting] = useState(false);
  const [classifying, setClassifying] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [replying, setReplying] = useState(false);

  const loadSummary = () =>
    api.get("/replies/summary").then(({ data }) => setSummary(data)).catch(() => {});

  const loadRows = async () => {
    setLoading(true);
    setSelected(new Set());
    try {
      if (tab === "replied") {
        const { data } = await api.get("/replies/replied");
        setRows(data);
      } else if (tab === "due") {
        const { data } = await api.get("/replies/follow-up-due", { params: { days } });
        setRows(data);
      } else {
        // Awaiting = sent, no reply yet, still inside the window
        const { data } = await api.get("/replies/follow-up-due", { params: { days: 0 } });
        setRows(data.filter((r) => (r.days_since_sent ?? 0) < days));
      }
    } catch (e) {
      toast.error("Could not load list");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadSummary(); }, []);
  useEffect(() => { loadRows(); }, [tab, days]);

  const sync = async () => {
    setSyncing(true);
    try {
      const { data } = await api.post("/replies/sync");
      if (data.initialized) {
        toast.info("Inbox tracking started. Replies from now on will be detected.");
      } else if (data.skipped) {
        toast.info("A sync is already running");
      } else {
        const matched = (data.matchedByHeader || 0) + (data.matchedBySender || 0);
        toast.success(
          `Scanned ${data.scanned || 0} new mail(s), matched ${matched} repl${matched === 1 ? "y" : "ies"}`
        );
      }
      await loadSummary();
      await loadRows();
    } catch (e) {
      toast.error(e.response?.data?.message || "IMAP sync failed");
    } finally {
      setSyncing(false);
    }
  };

  const toggle = (id) =>
    setSelected((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const visible = rows.filter((r) => {
    if (!q) return true;
    const hay = `${r.email} ${r.company} ${r.company_full || ""} ${r.hr_name || ""}`.toLowerCase();
    return hay.includes(q.toLowerCase());
  });

  const allChecked = visible.length > 0 && visible.every((r) => selected.has(r.id));
  const toggleAll = () =>
    setSelected(allChecked ? new Set() : new Set(visible.map((r) => r.id)));

  const openThread = async (id) => {
    setThread({ loading: true });
    setReplyText("");
    try {
      const { data } = await api.get(`/replies/${id}/thread`);
      setThread(data);
    } catch {
      toast.error("Could not open conversation");
      setThread(null);
    }
  };

  const sendReply = async () => {
    if (!replyText.trim()) return toast.error("Write something first");
    setReplying(true);
    try {
      const { data } = await api.post(`/replies/${thread.id}/reply`, { body: replyText });
      toast.success(
        data.threaded
          ? "Reply sent in the same thread"
          : "Reply sent (as a new thread — original had no Message-ID)"
      );
      setThread(null);
      setReplyText("");
      loadSummary();
      loadRows();
    } catch (e) {
      toast.error(e.response?.data?.message || "Could not send reply");
    } finally {
      setReplying(false);
    }
  };

  // AI: draft a suggested reply into the reply box (user reviews/edits, then sends).
  const suggestReply = async () => {
    if (!thread?.id) return;
    setSuggesting(true);
    try {
      const { data } = await api.post(`/ai/suggest-reply/${thread.id}`);
      setReplyText(data.draft || "");
      toast.success("Draft ready — review before sending");
    } catch (e) {
      toast.error(e.response?.data?.message || "Could not draft reply");
    } finally {
      setSuggesting(false);
    }
  };

  // AI: classify all un-categorized replies in one pass.
  const classifyAll = async () => {
    setClassifying(true);
    try {
      const { data } = await api.post("/ai/classify-pending");
      toast.success(`Classified ${data.classified} repl${data.classified === 1 ? "y" : "ies"}`);
      loadRows();
    } catch (e) {
      toast.error(e.response?.data?.message || "Classification failed");
    } finally {
      setClassifying(false);
    }
  };

  const markReplied = async (id) => {
    await api.post(`/replies/${id}/mark-replied`);
    toast.success("Marked as replied");
    loadSummary(); loadRows();
  };

  const unmarkReplied = async (id) => {
    await api.post(`/replies/${id}/unmark-replied`);
    toast.info("Reply mark removed");
    loadSummary(); loadRows();
  };

  /**
   * Push the selected contacts into the Compose draft and jump there.
   * Compose already restores rows from /drafts on mount, so this reuses the
   * existing (tested) import -> preview -> send path instead of a parallel one.
   * __in_reply_to carries the original Message-ID so the follow-up threads
   * under the first email rather than arriving as a fresh cold mail.
   */
  const queueFollowUp = async () => {
    const picked = rows.filter((r) => selected.has(r.id));
    if (!picked.length) return toast.error("Select at least one contact");

    const draftRows = picked.map((r) => ({
      email: r.email,
      hr_email: r.email,
      hr_name: r.hr_name || r.student_name || "",
      student_name: r.student_name || "",
      company_name: r.company_full || r.company || "",
      job_role: r.role || "",
      __in_reply_to: r.message_id || null,
    }));

    try {
      await api.put("/drafts", { rows: draftRows, templateId: "", schedule: "" });
      toast.success(`${draftRows.length} contact(s) moved to Compose`);
      navigate("/compose");
    } catch {
      toast.error("Could not prepare follow-up");
    }
  };

  const threadable = rows.filter((r) => selected.has(r.id) && r.message_id).length;
  const selectedCount = selected.size;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-extrabold">
            <IconReply /> Replies & Follow-ups
          </h1>
          <p className="text-sm text-slate-500">
            Last inbox check: {summary?.last_poll ? fmt(summary.last_poll) : "never"}
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn btn-ghost" onClick={classifyAll} disabled={classifying}>
            {classifying ? "Classifying…" : "✨ Classify replies"}
          </button>
          <button className="btn btn-ghost" onClick={sync} disabled={syncing}>
            <IconClock /> {syncing ? "Checking inbox…" : "Sync now"}
          </button>
        </div>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Sent" value={summary?.sent ?? "–"} />
        <Stat label="Replied" value={summary?.replied ?? "–"} tone="green" />
        <Stat label="Reply rate" value={summary ? `${summary.reply_rate}%` : "–"} tone="blue" />
        <Stat label="Awaiting" value={summary?.awaiting ?? "–"} hint="under 7 days" />
        <Stat label="Follow-up due" value={summary?.follow_up_due ?? "–"} tone="amber" hint="7+ days, no reply" />
      </div>

      {/* Controls */}
      <div className="card p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border border-slate-300 p-0.5 dark:border-slate-700">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  tab === t.key
                    ? "bg-brand-600 text-white"
                    : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {tab !== "replied" && (
            <label className="flex items-center gap-2 text-sm text-slate-500">
              Threshold
              <select
                className="input w-auto py-1"
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
              >
                {[3, 5, 7, 10, 14].map((d) => (
                  <option key={d} value={d}>{d} days</option>
                ))}
              </select>
            </label>
          )}

          <div className="relative ml-auto">
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400">
              <IconSearch />
            </span>
            <input
              className="input w-56 pl-9"
              placeholder="Search company or email"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>

          {tab !== "replied" && (
            <button
              className="btn btn-primary"
              onClick={queueFollowUp}
              disabled={!selectedCount}
            >
              <IconSend /> Follow up ({selectedCount})
            </button>
          )}
        </div>

        {tab !== "replied" && selectedCount > 0 && threadable < selectedCount && (
          <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
            {selectedCount - threadable} of {selectedCount} selected were sent before reply
            tracking existed — those follow-ups will start a new email thread instead of
            continuing the original one.
          </p>
        )}
      </div>

      {/* Table */}
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
            <tr>
              {tab !== "replied" && (
                <th className="w-10 p-3">
                  <input type="checkbox" checked={allChecked} onChange={toggleAll} />
                </th>
              )}
              <th className="p-3">Company</th>
              <th className="p-3">Contact</th>
              <th className="p-3">Subject</th>
              <th className="p-3">Sent</th>
              <th className="p-3">{tab === "replied" ? "Replied" : "Waiting"}</th>
              <th className="p-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={7} className="p-8 text-center text-slate-400">Loading…</td></tr>
            )}

            {!loading && !visible.length && (
              <tr>
                <td colSpan={7} className="p-8 text-center text-slate-400">
                  {tab === "replied"
                    ? "No replies detected yet."
                    : "Nothing here. Either everything got a reply, or nothing is old enough yet."}
                </td>
              </tr>
            )}

            {!loading && visible.map((r) => (
              <tr
                key={r.id}
                className="border-b border-slate-100 last:border-0 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/50"
              >
                {tab !== "replied" && (
                  <td className="p-3">
                    <input
                      type="checkbox"
                      checked={selected.has(r.id)}
                      onChange={() => toggle(r.id)}
                    />
                  </td>
                )}
                <td className="p-3">
                  <button
                    className="font-medium text-brand-600 hover:underline dark:text-brand-400"
                    onClick={() => openThread(r.id)}
                  >
                    {r.company_full || r.company || "—"}
                  </button>
                </td>
                <td className="p-3">
                  <div>{r.hr_name || "—"}</div>
                  <div className="text-xs text-slate-400">{r.email}</div>
                </td>
                <td className="max-w-xs truncate p-3 text-slate-500">{r.subject}</td>
                <td className="p-3 whitespace-nowrap text-slate-500">{fmt(r.sent_at)}</td>
                <td className="p-3 whitespace-nowrap">
                  {tab === "replied" ? (
                    <div>
                      <span className="badge bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300">
                        {fmt(r.replied_at)}
                      </span>
                      {r.reply_category && (
                        <span className="ml-1 badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                          {r.reply_category.replace("_", " ")}
                        </span>
                      )}
                      {r.reply_snippet && (
                        <div className="mt-1 max-w-xs truncate text-xs text-slate-400">
                          {r.reply_snippet}
                        </div>
                      )}
                    </div>
                  ) : (
                    <span
                      className={`badge ${
                        (r.days_since_sent ?? 0) >= days
                          ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
                          : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                      }`}
                    >
                      {r.days_since_sent ?? 0}d
                    </span>
                  )}
                </td>
                <td className="p-3 text-right">
                  {tab === "replied" ? (
                    <button
                      className="btn btn-ghost px-2 py-1"
                      title="Wrong match — undo"
                      onClick={() => unmarkReplied(r.id)}
                    >
                      <IconX />
                    </button>
                  ) : (
                    <button
                      className="btn btn-ghost px-2 py-1"
                      title="Replied elsewhere — mark manually"
                      onClick={() => markReplied(r.id)}
                    >
                      <IconCheck />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Conversation drawer */}
      {thread && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={() => setThread(null)}>
          <div
            className="h-full w-full max-w-2xl overflow-y-auto bg-white p-6 shadow-xl dark:bg-slate-900"
            onClick={(e) => e.stopPropagation()}
          >
            {thread.loading ? (
              <p className="text-slate-400">Loading…</p>
            ) : (
              <>
                <div className="mb-4 flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-lg font-extrabold">
                      {thread.company_full || thread.company}
                    </h2>
                    <p className="text-sm text-slate-500">
                      {thread.hr_name ? `${thread.hr_name} · ` : ""}{thread.email}
                    </p>
                  </div>
                  <button className="btn btn-ghost px-2 py-1" onClick={() => setThread(null)}>
                    <IconX />
                  </button>
                </div>

                {/* Sent */}
                <div className="card mb-4 p-4">
                  <div className="mb-2 flex items-center justify-between text-xs text-slate-500">
                    <span className="font-semibold uppercase tracking-wide">You sent</span>
                    <span>{fmt(thread.sent_at)}</span>
                  </div>
                  <div className="mb-2 font-medium">{thread.subject}</div>
                  <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words font-sans text-sm text-slate-600 dark:text-slate-300">
                    {thread.body}
                  </pre>
                </div>

                {/* Reply */}
                {thread.replied_at ? (
                  <div className="card mb-4 border-green-200 p-4 dark:border-green-900">
                    <div className="mb-2 flex items-center justify-between text-xs text-slate-500">
                      <span className="font-semibold uppercase tracking-wide text-green-600 dark:text-green-400">
                        Reply from {thread.reply_from}
                        {thread.reply_category && (
                          <span className="ml-2 rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-medium normal-case text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                            {thread.reply_category.replace("_", " ")}
                          </span>
                        )}
                      </span>
                      <span>{fmt(thread.replied_at)}</span>
                    </div>
                    <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words font-sans text-sm text-slate-700 dark:text-slate-200">
                      {thread.reply_body || thread.reply_snippet || "(No text captured — this reply arrived before body capture was added.)"}
                    </pre>
                  </div>
                ) : (
                  <p className="mb-4 text-sm text-slate-400">No reply yet.</p>
                )}

                {/* Compose reply */}
                <div className="card p-4">
                  <div className="mb-1 flex items-center justify-between">
                    <label className="label mb-0">
                      {thread.replied_at ? "Reply" : "Send a follow-up"}
                    </label>
                    {thread.replied_at && (
                      <button
                        className="btn btn-ghost px-2 py-1 text-xs"
                        onClick={suggestReply}
                        disabled={suggesting}
                        title="Draft a reply with AI — you can edit before sending"
                      >
                        {suggesting ? "Drafting…" : "✨ Suggest with AI"}
                      </button>
                    )}
                  </div>
                  <textarea
                    className="input min-h-[160px]"
                    placeholder="Type your message…"
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                  />
                  <div className="mt-3 flex items-center justify-between">
                    <span className="text-xs text-slate-400">
                      {thread.message_id
                        ? "Will continue the existing email thread"
                        : "Original has no Message-ID — this will start a new thread"}
                    </span>
                    <button className="btn btn-primary" onClick={sendReply} disabled={replying}>
                      <IconSend /> {replying ? "Sending…" : "Send"}
                    </button>
                  </div>
                </div>

                {thread.related?.length > 0 && (
                  <div className="mt-4">
                    <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Earlier mail to this address ({thread.related.length})
                    </div>
                    {thread.related.map((r) => (
                      <button
                        key={r.id}
                        onClick={() => openThread(r.id)}
                        className="mb-1 block w-full rounded-lg border border-slate-200 p-2 text-left text-sm hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800"
                      >
                        <span className="text-slate-500">{fmt(r.sent_at)}</span>
                        {r.replied_at && (
                          <span className="ml-2 badge bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300">
                            replied
                          </span>
                        )}
                        <div className="truncate">{r.subject}</div>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}