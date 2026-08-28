---
slug: xda-robot-claw
title: This Arduino-powered robot claw spins a globe between its fingers like it came from a supervillain's lair
sourceName: XDA Developers
sourceUrl: https://www.xda-developers.com/this-arduino-powered-robot-claw-spins-a-globe-between-its-fingers-like-something-out-of-a-supervillains-lair/
author: Simon Batt
date: 2026-08-14
retrieved: 2026-08-28
image: xda-robot-claw.jpg
excerpt: It leaves your hands free to tap your fingers together in evil contemplation.
build: Doc Ock's Robot Claw
---

**Summary**

* This Doc Ock–style robot claw slowly spins a globe, perfect for those "take over the world" vibes.
* It uses 12 Dynamixel servos, Arduino OpenRB-150, LED filaments, MOSFET, and a step-down for power.
* 4 potentiometers control speed/direction and offsets; STL files and build details available on Patreon.

You know, despite there being a ton of tinkerers out there making cool things, there's a surprising lack of villain-coded things. You'd think a community of gadget-making fanatics would dip into the classic Bond villain aesthetic every once in a while. Well, one person has brought their particularly sinister project to the internet, and I must say, it's very impressive.

## This robot claw spins a globe on your desk with some menacing lighting

### You just need to supply the evil laughter

Over on the [Arduino subreddit](https://www.reddit.com/r/arduino/comments/1vn8ux4/a_robot_claw_to_spin_a_globe_on_my_desk/), user OmarBuilds is showing off what they've been cooking. It's a cool, Doc Ock-styled claw that can hold a globe between its four fingers. It'll then use those fingers to slowly spin the globe, giving that cool "One day I'll take over the world" kind of feeling. It's not practical by any means, but practically never stops a tinkerer from making awesome builds.

OmarBuilds used a 3D printer to print the shell, but they also used the following hardware to make everything work:

* 1 x Arduino OpenRB-150
* 12 x Dynamixel XL430-W250-T
* 9 x Red 300mm LED filament
* 1 x Pololu-5592 12v to 3.3v step down (LED power)
* 1 x COM-24144 N MOSFET (switch on/off LEDs)

and 4 x potentiometers to control the globe's speed/direction, height, width, and depth of each offset step.

If you'd like to see a longer video showcasing the design and build process, you can check out [OmarBuilds' full coverage of their robotic claw](https://www.youtube.com/watch?v=pEU04FVNeZw).

And if you'd like to make your own, you can find the STLs and everything else you need to make one over on [OmarBuilds' Patreon](https://www.patreon.com/omarbuilds). They've announced that they're currently in the process of building the Leaper from Arc Raiders, so if that sounds like fun, be sure to throw OmarBuilds a follow.
