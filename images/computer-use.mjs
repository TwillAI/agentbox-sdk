import browserAgent from "./browser-agent.mjs";

const aptPackages = [
  "xvfb",
  "xauth",
  "openbox",
  "xdotool",
  "scrot",
  "imagemagick",
  "ffmpeg",
  "x11-utils",
  "dbus-x11",
];

export default {
  ...browserAgent,
  name: "computer-use",
  env: {
    ...browserAgent.env,
    DISPLAY: ":1",
    DISPLAY_NUM: "1",
    WIDTH: "1980",
    HEIGHT: "1080",
  },
  run: [
    ...browserAgent.run,
    `apt-get update && apt-get install -y --no-install-recommends ${aptPackages.join(" ")} && rm -rf /var/lib/apt/lists/*`,
  ],
};
