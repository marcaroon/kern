export function useRouter() {
  return {
    replace: (path: string) =>
      window.location.assign(new URL(path, window.location.origin)),
    refresh: () => window.location.reload(),
  };
}
export function redirect(path: string): never {
  window.location.assign(new URL(path, window.location.origin));
  throw new Error("Redirect");
}
export default function TestLink({
  href,
  children,
  ...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return (
    <a href={href} {...props}>
      {children}
    </a>
  );
}
