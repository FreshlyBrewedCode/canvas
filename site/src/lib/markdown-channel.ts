import { forChannel, linkForChannel } from "./channel";

/*
 * A Sätteri mdast plugin pointing the docs markdown at this build's channel
 * (`channel.ts`): code gets the channel's package and web app, `/docs/…` links
 * its base. Changes nothing on `latest`.
 */

interface Context {
  setProperty(node: unknown, key: string, value: string): void;
}

const rewrite =
  <K extends string>(key: K, to: (value: string) => string) =>
  (node: Readonly<Record<K, string>>, context: Context) => {
    const value = to(node[key]);
    if (value !== node[key]) context.setProperty(node, key, value);
  };

export const markdownChannel = {
  name: "canvas-docs-channel",
  code: rewrite("value", forChannel),
  inlineCode: rewrite("value", forChannel),
  link: rewrite("url", linkForChannel),
  definition: rewrite("url", linkForChannel),
};
