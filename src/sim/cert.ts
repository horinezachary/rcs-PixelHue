// A self-signed certificate for the simulator's discovery port only, as a real switcher's ucenter port
// presents one. It protects nothing: never use it for anything else.
export const SIM_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgKBeZwk0cVg1+1FD3
IAA3K90MmC1o+RVdQbqX/PzauDOhRANCAATQzGkUu2CbRYhLLmmVdDktHrzcj2jR
lIYT6mD0czt/b8lDckmib4bRcdj5i/X4ybmYbcGFpwOjElAzCMDCmkHk
-----END PRIVATE KEY-----`;

export const SIM_CERT = `-----BEGIN CERTIFICATE-----
MIIBkTCCATegAwIBAgIURQdbifCRhrTVPddlmkz+3t/cFr0wCgYIKoZIzj0EAwIw
HTEbMBkGA1UEAwwScGl4ZWxodWUtc2ltdWxhdG9yMCAXDTI2MTExNzA1MjYzNVoY
DzIxMjYxMDI0MDUyNjM1WjAdMRswGQYDVQQDDBJwaXhlbGh1ZS1zaW11bGF0b3Iw
WTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAATQzGkUu2CbRYhLLmmVdDktHrzcj2jR
lIYT6mD0czt/b8lDckmib4bRcdj5i/X4ybmYbcGFpwOjElAzCMDCmkHko1MwUTAd
BgNVHQ4EFgQU/9w6R65ENTDpNafAOJ0G5Ry3r5owHwYDVR0jBBgwFoAU/9w6R65E
NTDpNafAOJ0G5Ry3r5owDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNIADBF
AiB3VW7LHrQaKS/GavlG9owmCYY+GbXD1x7QlS3crdnUwwIhAPAaQ5QoD7WiEsAm
CrO1+84nCJQDaMhZqk/Fe+ftTDfR
-----END CERTIFICATE-----`;
