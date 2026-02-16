package crypto

import (
	"github.com/theQRL/go-qrllib/wallet/common"
	"github.com/theQRL/go-qrllib/wallet/ml_dsa_87"
)

// WalletResult holds the data extracted from a newly generated wallet.
// The wallet is zeroized after extraction — this struct is the only
// record of the key material.
type WalletResult struct {
	Address      string              // "Q" + 40 hex chars
	ExtendedSeed common.ExtendedSeed // 51 bytes: 3-byte descriptor + 48-byte seed
}

// GenerateWallet creates a new ML-DSA-87 wallet, extracts the address
// and extended seed, then zeroizes the wallet from memory.
func GenerateWallet() (*WalletResult, error) {
	w, err := ml_dsa_87.NewWallet()
	if err != nil {
		return nil, err
	}
	defer w.Zeroize()

	addr := w.GetAddressStr()
	eSeed, err := w.GetExtendedSeed()
	if err != nil {
		return nil, err
	}

	return &WalletResult{
		Address:      addr,
		ExtendedSeed: eSeed,
	}, nil
}

// IsValidAddress validates a QRL address string ("Q" + 40 hex chars).
func IsValidAddress(addr string) bool {
	return common.IsValidAddress(addr)
}
