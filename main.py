import decky
import subprocess


class Plugin:
    async def _main(self):
        decky.logger.info("VoiceType plugin loaded")

    async def _unload(self):
        decky.logger.info("VoiceType plugin unloaded")

    async def type_text(self, text: str) -> bool:
        """
        Types the given text at the current cursor position using xdotool.
        Requires xdotool to be installed on the Steam Deck:
            sudo pacman -S xdotool
        """
        try:
            decky.logger.info(f"VoiceType typing: {text!r}")
            subprocess.run(
                ["xdotool", "type", "--clearmodifiers", "--delay", "12", "--", text],
                check=True,
                timeout=15,
            )
            return True
        except FileNotFoundError:
            decky.logger.error(
                "xdotool not found. Install with: sudo pacman -S xdotool"
            )
            return False
        except subprocess.TimeoutExpired:
            decky.logger.error("xdotool timed out")
            return False
        except subprocess.CalledProcessError as e:
            decky.logger.error(f"xdotool exited with error: {e}")
            return False
        except Exception as e:
            decky.logger.error(f"Unexpected error in type_text: {e}")
            return False
