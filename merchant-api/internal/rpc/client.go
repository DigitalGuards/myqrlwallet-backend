package rpc

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Client is a minimal Zond JSON-RPC client.
// It only uses whitelisted methods compatible with the qrlwallet.com proxy.
type Client struct {
	endpoint   string
	httpClient *http.Client
}

// NewClient creates a new RPC client.
func NewClient(endpoint string, timeout time.Duration) *Client {
	return &Client{
		endpoint: endpoint,
		httpClient: &http.Client{
			Timeout: timeout,
		},
	}
}

// GetBalance returns the balance of an address in wei.
// The address should be in Q-format ("Q..." 41 chars) — it will be
// converted to 0x-format for the RPC call.
func (c *Client) GetBalance(ctx context.Context, qAddress string) (*big.Int, error) {
	hexAddr := qAddressToHex(qAddress)
	result, err := c.call(ctx, "zond_getBalance", hexAddr, "latest")
	if err != nil {
		return nil, err
	}

	var hexBalance string
	if err := json.Unmarshal(result, &hexBalance); err != nil {
		return nil, fmt.Errorf("unmarshal balance: %w", err)
	}

	balance := new(big.Int)
	hexBalance = strings.TrimPrefix(hexBalance, "0x")
	if hexBalance == "" || hexBalance == "0" {
		return balance, nil
	}
	balance.SetString(hexBalance, 16)
	return balance, nil
}

// GetBlockNumber returns the current block number.
func (c *Client) GetBlockNumber(ctx context.Context) (uint64, error) {
	result, err := c.call(ctx, "zond_blockNumber")
	if err != nil {
		return 0, err
	}

	var hexBlock string
	if err := json.Unmarshal(result, &hexBlock); err != nil {
		return 0, fmt.Errorf("unmarshal block number: %w", err)
	}

	hexBlock = strings.TrimPrefix(hexBlock, "0x")
	return strconv.ParseUint(hexBlock, 16, 64)
}

// GetTransactionReceipt returns the receipt for a transaction hash.
// Returns nil if the transaction is not yet mined.
func (c *Client) GetTransactionReceipt(ctx context.Context, txHash string) (*TxReceipt, error) {
	result, err := c.call(ctx, "zond_getTransactionReceipt", txHash)
	if err != nil {
		return nil, err
	}

	// null result means tx not yet mined
	if string(result) == "null" {
		return nil, nil
	}

	var receipt TxReceipt
	if err := json.Unmarshal(result, &receipt); err != nil {
		return nil, fmt.Errorf("unmarshal receipt: %w", err)
	}
	return &receipt, nil
}

// call makes a JSON-RPC 2.0 call and returns the raw result.
func (c *Client) call(ctx context.Context, method string, params ...interface{}) (json.RawMessage, error) {
	if params == nil {
		params = []interface{}{}
	}

	reqBody := jsonRPCRequest{
		JSONRPC: "2.0",
		Method:  method,
		Params:  params,
		ID:      1,
	}

	body, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("RPC call %s: %w", method, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("RPC call %s: HTTP %d", method, resp.StatusCode)
	}

	var rpcResp jsonRPCResponse
	if err := json.NewDecoder(resp.Body).Decode(&rpcResp); err != nil {
		return nil, fmt.Errorf("decode RPC response: %w", err)
	}

	if rpcResp.Error != nil {
		return nil, fmt.Errorf("RPC error %d: %s", rpcResp.Error.Code, rpcResp.Error.Message)
	}

	return rpcResp.Result, nil
}

// qAddressToHex converts a Q-format address ("Q" + 40 hex) to 0x-format.
func qAddressToHex(addr string) string {
	if strings.HasPrefix(addr, "Q") {
		return "0x" + addr[1:]
	}
	if strings.HasPrefix(addr, "0x") || strings.HasPrefix(addr, "0X") {
		return addr
	}
	return "0x" + addr
}
