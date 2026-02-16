package crypto

import (
	"bytes"
	"crypto/rand"
	"testing"
)

func TestEncryptDecryptRoundTrip(t *testing.T) {
	var key [32]byte
	if _, err := rand.Read(key[:]); err != nil {
		t.Fatal(err)
	}

	plaintext := []byte("secret seed data that must be protected")

	ciphertext, nonce, err := Encrypt(key, plaintext)
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}

	if bytes.Equal(ciphertext, plaintext) {
		t.Fatal("ciphertext should differ from plaintext")
	}

	decrypted, err := Decrypt(key, ciphertext, nonce)
	if err != nil {
		t.Fatalf("Decrypt: %v", err)
	}

	if !bytes.Equal(decrypted, plaintext) {
		t.Fatalf("decrypted text does not match: got %q, want %q", decrypted, plaintext)
	}
}

func TestDecryptWithWrongKey(t *testing.T) {
	var key1, key2 [32]byte
	rand.Read(key1[:])
	rand.Read(key2[:])

	ciphertext, nonce, err := Encrypt(key1, []byte("secret"))
	if err != nil {
		t.Fatal(err)
	}

	_, err = Decrypt(key2, ciphertext, nonce)
	if err == nil {
		t.Fatal("expected error decrypting with wrong key")
	}
}

func TestDecryptWithWrongNonce(t *testing.T) {
	var key [32]byte
	rand.Read(key[:])

	ciphertext, _, err := Encrypt(key, []byte("secret"))
	if err != nil {
		t.Fatal(err)
	}

	wrongNonce := make([]byte, 12) // GCM nonce is 12 bytes
	rand.Read(wrongNonce)

	_, err = Decrypt(key, ciphertext, wrongNonce)
	if err == nil {
		t.Fatal("expected error decrypting with wrong nonce")
	}
}

func TestGenerateWallet(t *testing.T) {
	result, err := GenerateWallet()
	if err != nil {
		t.Fatalf("GenerateWallet: %v", err)
	}

	if len(result.Address) != 41 {
		t.Fatalf("expected address length 41, got %d: %s", len(result.Address), result.Address)
	}

	if result.Address[0] != 'Q' {
		t.Fatalf("expected address to start with Q, got %c", result.Address[0])
	}

	if !IsValidAddress(result.Address) {
		t.Fatalf("generated address is not valid: %s", result.Address)
	}

	// Extended seed should be 51 bytes
	seed := result.ExtendedSeed
	allZero := true
	for _, b := range seed {
		if b != 0 {
			allZero = false
			break
		}
	}
	if allZero {
		t.Fatal("extended seed is all zeros")
	}
}

func TestEncryptDecryptSeed(t *testing.T) {
	var key [32]byte
	rand.Read(key[:])

	result, err := GenerateWallet()
	if err != nil {
		t.Fatal(err)
	}

	seedBytes := result.ExtendedSeed[:]
	ciphertext, nonce, err := Encrypt(key, seedBytes)
	if err != nil {
		t.Fatal(err)
	}

	decrypted, err := Decrypt(key, ciphertext, nonce)
	if err != nil {
		t.Fatal(err)
	}

	if !bytes.Equal(decrypted, seedBytes) {
		t.Fatal("seed round-trip failed")
	}
}
