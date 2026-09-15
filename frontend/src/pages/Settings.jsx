import { useEffect, useState } from "react";
import { api } from "../lib/api.js";
import { useToast } from "../lib/toast.jsx";
import { IconCheck } from "../components/Icons.jsx";

export default function Settings() {
  const toast = useToast();
  const [s, setS] = useState(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => { api.get("/settings").then(({ data }) => setS(data)); }, []);

  const save = async () => {
    await api.put("/settings", s);
    toast.success("Settings saved");
  };

  const testGroqConn = async () => {
    try {
      await api.put("/settings", s);
      const { data } = await api.post("/settings/test-groq");
      toast.success(data.message);
    } catch (e) {
      toast.error(e.response?.data?.message || "Groq test failed");
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      // Save first so the test uses latest values
      await api.put("/settings", s);
      const { data } = await api.post("/settings/test");
      toast.success(data.message);
    } catch (e) {
      toast.error(e.response?.data?.message || "Connection failed");
    } finally {
      setTesting(false);
    }
  };

  if (!s) return <div className="text-slate-500">Loading…</div>;

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold">Settings</h1>
        <p className="text-sm text-slate-500">Gmail SMTP credentials & signature</p>
      </div>

      <div className="card space-y-4 p-5">
        <h2 className="font-bold">Gmail Connection</h2>
        <div className="rounded-lg bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
          Use a Gmail <b>App Password</b> (not your login password). Enable 2-Step Verification, then create an App Password at
          <span className="font-mono"> myaccount.google.com → Security → App passwords</span>.
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label">SMTP Host</label>
            <input className="input" value={s.smtp_host} onChange={(e) => setS({ ...s, smtp_host: e.target.value })} />
          </div>
          <div>
            <label className="label">SMTP Port</label>
            <input className="input" value={s.smtp_port} onChange={(e) => setS({ ...s, smtp_port: e.target.value })} />
          </div>
        </div>
        <div>
          <label className="label">Gmail Address</label>
          <input className="input" value={s.gmail_user} onChange={(e) => setS({ ...s, gmail_user: e.target.value })}
            placeholder="you@gmail.com" />
        </div>
        <div>
          <label className="label">App Password</label>
          <input type="password" className="input" value={s.gmail_app_password}
            onChange={(e) => setS({ ...s, gmail_app_password: e.target.value })}
            placeholder="16-character app password" />
        </div>
        <div className="flex gap-2">
          <button className="btn btn-primary" onClick={save}>Save</button>
          <button className="btn btn-ghost" onClick={test} disabled={testing}>
            {testing ? "Testing…" : <><IconCheck /> Test Connection</>}
          </button>
        </div>
      </div>

      <div className="card space-y-4 p-5">
        <h2 className="font-bold">Sending Limits</h2>
        <div className="rounded-lg bg-blue-50 p-3 text-xs text-blue-800 dark:bg-blue-900/20 dark:text-blue-300">
          Gmail caps daily sends (≈500 for personal, 2000 for Workspace). For cold
          outreach, staying well below the cap protects the account's reputation.
          On a shared mailbox this limit is counted across <b>all</b> coordinators.
        </div>
        <div className="max-w-xs">
          <label className="label">Daily send limit</label>
          <input
            type="number"
            min="1"
            className="input"
            value={s.daily_limit ?? "150"}
            onChange={(e) => setS({ ...s, daily_limit: e.target.value })}
          />
          <p className="mt-1 text-xs text-slate-400">
            Sends beyond this per day are held as Pending and continue later.
          </p>
        </div>
        <button className="btn btn-primary" onClick={save}>Save</button>
      </div>

      <div className="card space-y-4 p-5">
        <h2 className="font-bold">AI Personalization (Groq)</h2>
        <div className="rounded-lg bg-blue-50 p-3 text-xs text-blue-800 dark:bg-blue-900/20 dark:text-blue-300">
          Powers AI email intros and reply classification. Free key from
          console.groq.com. The model is picked automatically from Groq's live
          catalogue, so it keeps working when models are retired.
        </div>
        <div className="max-w-md">
          <label className="label">Groq API Key</label>
          <input
            type="password"
            className="input"
            placeholder={s.has_groq_key ? "•••••••• (saved)" : "gsk_..."}
            value={s.groq_api_key === "********" ? "" : (s.groq_api_key || "")}
            onChange={(e) => setS({ ...s, groq_api_key: e.target.value })}
          />
        </div>
        <div className="max-w-md">
          <label className="label">Student batch description</label>
          <textarea
            className="input min-h-[70px]"
            placeholder="graduating M.Tech (Applied AI) students skilled in AI, ML, NLP and LLMs"
            value={s.batch_description || ""}
            onChange={(e) => setS({ ...s, batch_description: e.target.value })}
          />
          <p className="mt-1 text-xs text-slate-400">
            Given to the AI when writing intros, so it knows who it is offering.
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn btn-primary" onClick={save}>Save</button>
          <button className="btn btn-ghost" onClick={testGroqConn}>Test Groq</button>
        </div>
      </div>

      <div className="card space-y-4 p-5">
        <h2 className="font-bold">Sender & Signature</h2>
        <div>
          <label className="label">Sender Name</label>
          <input className="input" value={s.sender_name} onChange={(e) => setS({ ...s, sender_name: e.target.value })} />
        </div>
        <div>
          <label className="label">Signature (available as <code>{"{{signature}}"}</code>)</label>
          <textarea rows={4} className="input" value={s.signature}
            onChange={(e) => setS({ ...s, signature: e.target.value })} />
        </div>
        <button className="btn btn-primary" onClick={save}>Save</button>
      </div>

      <div className="card space-y-4 p-5">
        <h2 className="font-bold">College Profile</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label">College Name</label>
            <input className="input" value={s.college_name || ""}
              onChange={(e) => setS({ ...s, college_name: e.target.value })} />
          </div>
          <div>
            <label className="label">College Location</label>
            <input className="input" value={s.college_location || ""}
              onChange={(e) => setS({ ...s, college_location: e.target.value })} />
          </div>
          <div>
            <label className="label">Placement Officer</label>
            <input className="input" value={s.placement_officer || ""}
              onChange={(e) => setS({ ...s, placement_officer: e.target.value })} />
          </div>
          <div>
            <label className="label">Contact Number</label>
            <input className="input" value={s.contact_number || ""}
              onChange={(e) => setS({ ...s, contact_number: e.target.value })} />
          </div>
          <div>
            <label className="label">Website</label>
            <input className="input" value={s.website || ""}
              onChange={(e) => setS({ ...s, website: e.target.value })} />
          </div>
          <div>
            <label className="label">Brochure Link</label>
            <input className="input" value={s.brochure_link || ""}
              onChange={(e) => setS({ ...s, brochure_link: e.target.value })} />
          </div>
        </div>
        <button className="btn btn-primary" onClick={save}>Save</button>
      </div>
    </div>
  );
}