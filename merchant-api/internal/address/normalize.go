package address

import "strings"

// Normalize converts Z-prefix addresses to Q-prefix. Leaves Q-prefix as-is.
func Normalize(addr string) string {
	if strings.HasPrefix(addr, "Z") || strings.HasPrefix(addr, "z") {
		return "Q" + addr[1:]
	}
	return addr
}
