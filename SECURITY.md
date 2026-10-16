# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately through GitHub: open the **Security** tab of the repository, choose **Report a vulnerability** and describe what you found, how to reproduce it and what you think the impact is.

You can expect a first response within a week. If the report is valid, we work on a fix and release it as soon as we can, and credit you in the release notes if you like.

This is a small open-source project: there is no bug bounty.

## Supported versions

Only the latest release is supported. Security fixes are not backported.

## Scope

In scope:

- The app itself.
- The way it stores the Jira API token: in `~/.issuemon/issuemon.json`, readable only by the user (mode 0600, the folder 0700). Anything that exposes the token to another user, to the renderer process or to a place other than your own Jira site is a vulnerability.
- The requests the app makes to Jira.

Out of scope:

- Anything that needs access to the user's account on the Mac already: any program running as the same user can read the data file, which the README states.
- Vulnerabilities in Jira itself, Electron or other dependencies without a way to exploit them through IssueMon. Report those to their own projects.
- The fact that the app is signed ad hoc and not notarized.
