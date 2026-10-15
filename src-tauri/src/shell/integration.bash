# PHPBlitz shell integration for bash (used as --init-file, so load the usual startup files first).
if [ -f /etc/profile ]; then . /etc/profile; fi
if [ -f ~/.bash_profile ]; then . ~/.bash_profile
elif [ -f ~/.bash_login ]; then . ~/.bash_login
elif [ -f ~/.profile ]; then . ~/.profile
elif [ -f ~/.bashrc ]; then . ~/.bashrc
fi

# OSC 133 marks: D;exit code of the last command, A before the prompt, B after it.
__phpblitz_history=
__phpblitz_prompt() {
  local code=$? last
  last=$(HISTTIMEFORMAT= builtin history 1)
  if [ -n "$__phpblitz_history" ] && [ "$last" != "$__phpblitz_history" ]; then
    printf '\033]133;D;%s\007' "$code"
  fi
  __phpblitz_history=${last:- }
  printf '\033]133;A\007'
  return $code
}
PROMPT_COMMAND="__phpblitz_prompt${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
PS1="$PS1\[\033]133;B\007\]"
