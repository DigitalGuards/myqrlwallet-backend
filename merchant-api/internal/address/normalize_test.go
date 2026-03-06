package address

import "testing"

func TestNormalize_ZPrefixToQ(t *testing.T) {
	got := Normalize("Z1234abcd")
	if got != "Q1234abcd" {
		t.Errorf("Normalize(Z...) = %q, want Q1234abcd", got)
	}
}

func TestNormalize_LowercaseZToQ(t *testing.T) {
	got := Normalize("z1234abcd")
	if got != "Q1234abcd" {
		t.Errorf("Normalize(z...) = %q, want Q1234abcd", got)
	}
}

func TestNormalize_QPrefixUnchanged(t *testing.T) {
	got := Normalize("Q1234abcd")
	if got != "Q1234abcd" {
		t.Errorf("Normalize(Q...) = %q, want Q1234abcd", got)
	}
}

func TestNormalize_OtherPrefixUnchanged(t *testing.T) {
	got := Normalize("0x1234abcd")
	if got != "0x1234abcd" {
		t.Errorf("Normalize(0x...) = %q, want 0x1234abcd", got)
	}
}
