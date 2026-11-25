/** Native option grammar; aliases use these exact rules. */
export const codexRootValues = '-m --model -c --config -s --sandbox -a --ask-for-approval -p --profile --enable --disable --add-dir --local-provider'.split(' ');
export const codexRootFlags = '--strict-config --oss --search --no-daemon --approve-for-me --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust'.split(' ');
export const codexSharedValues = '--thread-source --cyber-access-program --output-schema -o --output-last-message'.split(' ');
export const codexSharedFlags = '--skip-git-repo-check --ephemeral --ignore-user-config --ignore-rules --json'.split(' ');
