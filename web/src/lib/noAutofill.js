// Svelte action: stops password managers (Chrome + 1Password/Bitwarden/LastPass
// extensions) from targeting a text input that isn't a username/password field.
// autocomplete="off" alone isn't enough — extensions use their own heuristics
// and often ignore it, so this also sets every vendor-specific opt-out attribute.
export function noAutofill(node) {
  node.setAttribute('autocomplete', 'off');
  node.setAttribute('data-lpignore', 'true');   // LastPass
  node.setAttribute('data-1p-ignore', '');      // 1Password
  node.setAttribute('data-bwignore', 'true');   // Bitwarden
  node.setAttribute('data-form-type', 'other'); // Dashlane + generic heuristic hint
}
