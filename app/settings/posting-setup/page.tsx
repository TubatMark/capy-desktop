import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { CopyText } from "@/components/copy-text";

export const metadata: Metadata = { title: "Posting setup · capy" };

const A = ({ href, children }: { href: string; children: React.ReactNode }) => (
  <a href={href} target="_blank" rel="noreferrer" className="underline underline-offset-2">
    {children}
  </a>
);

/** Step-by-step: create a free developer app on each platform and connect it. */
export default function PostingSetupPage() {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-8">
      <div className="space-y-2">
        <Link href="/settings#accounts" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> Back to Settings
        </Link>
        <h1 className="text-2xl font-semibold">Set up posting</h1>
        <p className="text-pretty text-muted-foreground">
          capy posts with your own developer app on each platform, so there's no subscription and no middleman: your clips go straight from this computer to
          your account. Each setup takes about 15 minutes, once. You only need the platforms you use.
        </p>
      </div>

      <Section id="youtube" title="YouTube Shorts">
        <Step>
          Open the <A href="https://console.cloud.google.com/projectcreate">Google Cloud console</A> and create a project (any name, e.g. "capy").
        </Step>
        <Step>
          In <A href="https://console.cloud.google.com/apis/library/youtube.googleapis.com">APIs &amp; Services → Library</A>, enable <b>YouTube Data API v3</b>, then search
          for and enable <A href="https://console.cloud.google.com/apis/library/youtubeanalytics.googleapis.com">YouTube Analytics API</A> too (the Channel page&apos;s watch
          time and search terms).
        </Step>
        <Step>
          Go to <b>OAuth consent screen</b>: choose <b>External</b>, fill in the app name and your email, and add the scopes <code>youtube.upload</code>,{" "}
          <code>youtube.readonly</code>, <code>yt-analytics.readonly</code> and <code>youtube.force-ssl</code> (the last lets capy fix old videos&apos; titles and tags
          when you click Update). Then click <b>Publish app</b> so it's "In production". You don't need Google's verification for yourself: at sign-in,
          click <i>Advanced → Go to capy (unsafe)</i>. Leaving it in Testing signs you out every 7 days.
        </Step>
        <Step>
          Go to <b>Credentials → Create credentials → OAuth client ID</b>, type <b>Desktop app</b>. Copy the client ID and secret into Settings → Posting
          accounts → YouTube and click <b>Connect</b>.
        </Step>
        <Note>
          Google keeps videos uploaded by new, unaudited projects <b>private</b>. capy uploads them anyway and marks them "Needs action" with a link: open it and
          set the video to Public. To have them go public on their own, ask for the free{" "}
          <A href="https://support.google.com/youtube/contact/yt_api_form">YouTube API Services audit</A> (say it's a personal tool that uploads your own
          Shorts).
        </Note>
      </Section>

      <Section id="instagram" title="Instagram Reels">
        <Step>
          In the Instagram app, switch to a <b>Professional account</b> (Creator or Business) and link it to a <b>Facebook Page</b> (Settings → Account type and
          tools; Accounts Center → Facebook Page).
        </Step>
        <Step>
          At <A href="https://developers.facebook.com/apps">Meta for Developers</A>, create an app of type <b>Business</b>. Add the products{" "}
          <b>Facebook Login for Business</b> and <b>Instagram</b> (Instagram API with Facebook Login).
        </Step>
        <Step>
          In Facebook Login for Business → Settings, add this to <b>Valid OAuth Redirect URIs</b>:
          <CopyText text="http://localhost:53682/callback" />
        </Step>
        <Step>
          Leave the app in <b>Development</b> mode: it works for your own account without App Review. Copy the <b>App ID</b> and <b>App secret</b> (App
          settings → Basic) into capy and click <b>Connect</b>. Grant access to your Page and Instagram account when asked.
        </Step>
        <Note>Reels post publicly right away. Meta's sign-in lasts about 60 days; capy renews it, and asks you to reconnect if it can't.</Note>
      </Section>

      <Section id="tiktok" title="TikTok">
        <Step>
          At <A href="https://developers.tiktok.com/apps">TikTok for Developers</A>, create an app.
        </Step>
        <Step>
          Add <b>Login Kit</b> with platform <b>Desktop</b>, and this redirect URI:
          <CopyText text="http://localhost:53682/callback" />
        </Step>
        <Step>
          Add the <b>Content Posting API</b> and the scopes <code>user.info.basic</code> and <code>video.upload</code> (add <code>video.publish</code> only if you
          want direct posting later).
        </Step>
        <Step>
          Under <b>Sandbox</b>, add your TikTok account as a target user (or submit the app for review). Copy the <b>Client key</b> and <b>Client secret</b> into
          capy and click <b>Connect</b>.
        </Step>
        <Note>
          Until TikTok audits your app, capy sends each clip to your <b>TikTok inbox</b>: you get a notification, add a sound if you like, and tap Post. The
          caption is on the Queue page to copy. After the audit, switch TikTok to "Post directly" in Settings and reconnect.
        </Note>
      </Section>
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20 space-y-3 rounded-xl border bg-card p-5">
      <h2 className="text-lg font-semibold">{title}</h2>
      <ol className="list-decimal space-y-3 pl-5 text-sm leading-relaxed">{children}</ol>
    </section>
  );
}
const Step = ({ children }: { children: React.ReactNode }) => <li className="text-pretty">{children}</li>;
const Note = ({ children }: { children: React.ReactNode }) => <p className="-ml-5 rounded-lg bg-muted/60 p-3 text-sm text-muted-foreground">{children}</p>;
