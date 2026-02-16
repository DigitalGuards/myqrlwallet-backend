package zondscan

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Client is a thin HTTP client for the zondscan.com REST API.
type Client struct {
	baseURL    string
	httpClient *http.Client
}

// NewClient creates a new zondscan API client.
func NewClient(baseURL string, timeout time.Duration) *Client {
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		httpClient: &http.Client{
			Timeout: timeout,
		},
	}
}

// Transaction represents a single transaction within a block.
type Transaction struct {
	Hash   string `json:"hash"`
	From   string `json:"from"`
	To     string `json:"to"`
	Value  string `json:"value"`
	Status string `json:"status"`
}

// Block represents a parsed block with its transactions.
type Block struct {
	Number       uint64
	Transactions []Transaction
}

// blockResponse matches the zondscan /api/block/:number JSON structure.
type blockResponse struct {
	Block struct {
		Result struct {
			Number       string        `json:"number"`
			Transactions []Transaction `json:"transactions"`
		} `json:"result"`
	} `json:"block"`
}

// GetLatestBlock returns the latest block number from zondscan.
func (c *Client) GetLatestBlock(ctx context.Context) (uint64, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", c.baseURL+"/latestblock", nil)
	if err != nil {
		return 0, fmt.Errorf("create request: %w", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return 0, fmt.Errorf("fetch latest block: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("unexpected status %d", resp.StatusCode)
	}

	var result struct {
		LatestBlock int64 `json:"latestBlock"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return 0, fmt.Errorf("decode response: %w", err)
	}

	return uint64(result.LatestBlock), nil
}

// GetBlock fetches a block by number from zondscan.
func (c *Client) GetBlock(ctx context.Context, number uint64) (*Block, error) {
	url := fmt.Sprintf("%s/block/%d", c.baseURL, number)
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch block %d: %w", number, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("block %d: unexpected status %d", number, resp.StatusCode)
	}

	var raw blockResponse
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, fmt.Errorf("decode block %d: %w", number, err)
	}

	blockNum, err := hexToUint64(raw.Block.Result.Number)
	if err != nil {
		return nil, fmt.Errorf("parse block number %q: %w", raw.Block.Result.Number, err)
	}

	return &Block{
		Number:       blockNum,
		Transactions: raw.Block.Result.Transactions,
	}, nil
}

func hexToUint64(s string) (uint64, error) {
	s = strings.TrimPrefix(s, "0x")
	return strconv.ParseUint(s, 16, 64)
}
