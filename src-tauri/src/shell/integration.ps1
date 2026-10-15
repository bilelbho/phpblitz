# PHPBlitz shell integration: marks each prompt and the exit code of the last command
# (OSC 133, the FinalTerm marks) so the terminal can draw command blocks.
$Global:__pbPrompt = $function:prompt
$Global:__pbHistory = -1
function Global:prompt {
    $ok = $?
    $lastExit = $Global:LASTEXITCODE
    $e = [char]27
    $bel = [char]7
    $last = Get-History -Count 1
    $id = if ($last) { $last.Id } else { 0 }
    $out = ''
    if ($Global:__pbHistory -ge 0 -and $id -ne $Global:__pbHistory) {
        $code = if ($ok) { 0 } elseif ($lastExit) { $lastExit } else { 1 }
        $out += "$e]133;D;$code$bel"
    }
    $Global:__pbHistory = $id
    $out += "$e]133;A$bel"
    $out += & $Global:__pbPrompt
    $Global:LASTEXITCODE = $lastExit
    $out + "$e]133;B$bel"
}
